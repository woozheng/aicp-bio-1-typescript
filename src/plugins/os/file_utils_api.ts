/**
 * os/file_utils_api — 文件读写工具
 *
 * action:
 *   read_file        读文件（>100KB 只返回尾部预览）
 *   read_file_lines  按行读文件（大文件用）
 *   write_file       写文件（全量覆盖，允许空内容）
 *   append_file      追加文件
 *   edit_file        局部替换（查找替换）
 *   apply_patch      应用 diff 补丁（unified diff）
 *   list_dir         列目录
 *   delete_file      删文件
 *   exists           检查存在
 *   file_stat        文件属性
 *   mkdir            建目录
 *
 * 参数命名约定：
 *   - write_file / append_file / apply_patch 都用 content
 *   - content 走 @@CONTENT@@ 块
 *   - edit_file 用 find / replace（短文本，不走块）
 *   - read_file_lines 用 start_line / end_line（行号从 1 开始）
 *
 * 路径策略：
 *   - 所有相对路径锚定到 PROJECT_ROOT（项目根）
 *   - 绝对路径原样使用（但过黑名单）
 *   - 禁止访问系统目录
 */

import { readFile, writeFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve, isAbsolute, normalize, relative } from "node:path";
import type { Envelop } from "../../core/Envelop.js";
import type { Agent } from "../../core/Agent.js";

// ============================================================
// 常量
// ============================================================

const MAX_INLINE_SIZE = 100 * 1024; // 100KB

// ★ 项目根：以服务启动时的 CWD 为准
// 如果你的服务不是从项目根启动，改成：
//   const PROJECT_ROOT = resolve(__dirname, "..", "..", "..", "..");
const PROJECT_ROOT = process.cwd();

// ★ 系统目录黑名单（绝对路径前缀，不区分大小写）
const FORBIDDEN_PREFIXES = [
  // Windows
  "c:/windows/",
  "c:/program files/",
  "c:/program files (x86)/",
  "c:/system32/",
  "c:/syswow64/",
  "c:/boot/",
  "c:/efi/",
  "c:/perflogs/",
  "c:/programdata/",
  "c:/recovery/",
  "c:/system volume information/",
  // Linux
  "/etc/",
  "/proc/",
  "/sys/",
  "/boot/",
  "/dev/",
  "/root/",
  "/usr/",
  "/bin/",
  "/sbin/",
  "/lib/",
  "/lib64/",
  "/opt/",
  "/var/",
  "/tmp/",
  "/run/",
  "/mnt/",
  "/media/",
  "/srv/",
  "/lost+found/",
];

/**
 * 解析路径：
 * - 绝对路径 → 过黑名单后原样返回
 * - 相对路径 → 锚定到 PROJECT_ROOT
 * - 黑名单命中 → 抛错
 */
function resolvePath(inputPath: string): string {
  if (typeof inputPath !== "string" || !inputPath) {
    throw new Error("path 必须是非空字符串");
  }

  // 统一正斜杠，便于黑名单比较
  const normalized = inputPath.replace(/\\/g, "/");

  // 黑名单检查（只看前缀）
  const lower = normalized.toLowerCase();
  for (const forbidden of FORBIDDEN_PREFIXES) {
    if (lower.startsWith(forbidden)) {
      throw new Error(`禁止访问系统目录: ${inputPath}`);
    }
  }

  // 绝对路径 → 原样
  if (isAbsolute(normalized)) {
    return normalize(normalized);
  }

  // 相对路径 → 锚定项目根
  return resolve(PROJECT_ROOT, normalized);
}

/**
 * 把绝对路径转回相对项目根的展示路径（用于返回给 LLM）
 */
function displayPath(absPath: string): string {
  try {
    const rel = relative(PROJECT_ROOT, absPath);
    return rel.replace(/\\/g, "/") || ".";
  } catch {
    return absPath;
  }
}

// ============================================================
// applyPatch — 应用 unified diff 补丁
// ============================================================

interface PatchLine {
  type: "context" | "remove" | "add";
  text: string;
}

interface Hunk {
  lines: PatchLine[];
}

function parsePatch(patch: string): Hunk[] {
  const patchLines = patch.split("\n");
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;

  for (let i = 0; i < patchLines.length; i++) {
    const line = patchLines[i];

    if (line.startsWith("---") || line.startsWith("+++")) continue;

    const hunkMatch = line.match(/^@@ -\d+,\d+ \+\d+,\d+ @@/);
    if (hunkMatch) {
      if (current) pushHunk(hunks, current);
      current = { lines: [] };
      continue;
    }

    if (current) {
      if (line.startsWith(" ")) {
        current.lines.push({ type: "context", text: line.slice(1) });
      } else if (line.startsWith("-")) {
        current.lines.push({ type: "remove", text: line.slice(1) });
      } else if (line.startsWith("+")) {
        current.lines.push({ type: "add", text: line.slice(1) });
      } else if (line === "") {
        current.lines.push({ type: "context", text: "" });
      }
    }
  }
  if (current) pushHunk(hunks, current);

  return hunks;
}

function pushHunk(hunks: Hunk[], hunk: Hunk): void {
  while (
    hunk.lines.length > 0 &&
    hunk.lines[hunk.lines.length - 1].type === "context" &&
    hunk.lines[hunk.lines.length - 1].text === ""
  ) {
    hunk.lines.pop();
  }
  hunks.push(hunk);
}

function applyPatch(
  content: string,
  patch: string
): { ok: boolean; result?: string; error?: string } {
  let hunks: Hunk[];
  try {
    hunks = parsePatch(patch);
  } catch (e: any) {
    return { ok: false, error: `patch 解析失败: ${e?.message ?? e}` };
  }

  if (hunks.length === 0) {
    return { ok: false, error: "没有找到有效的 hunk" };
  }

  let result = content;

  for (let h = 0; h < hunks.length; h++) {
    const hunk = hunks[h];

    const oldText = hunk.lines
      .filter((l) => l.type === "context" || l.type === "remove")
      .map((l) => l.text)
      .join("\n");

    const newText = hunk.lines
      .filter((l) => l.type === "context" || l.type === "add")
      .map((l) => l.text)
      .join("\n");

    if (!oldText) {
      return { ok: false, error: `hunk #${h + 1} 没有上下文或删除行` };
    }

    const idx = result.indexOf(oldText);
    if (idx === -1) {
      return {
        ok: false,
        error: `hunk #${h + 1} 不匹配（前 50 字: ${oldText.slice(0, 50)}）`,
      };
    }

    const secondIdx = result.indexOf(oldText, idx + 1);
    if (secondIdx !== -1) {
      return { ok: false, error: `hunk #${h + 1} 不唯一，匹配到多个位置` };
    }

    result = result.slice(0, idx) + newText + result.slice(idx + oldText.length);
  }

  return { ok: true, result };
}

// ============================================================
// 工具函数
// ============================================================

function err(envelop: Envelop, msg: string): Envelop {
  envelop.payload = { ok: false, error: msg };
  return envelop;
}

// ============================================================
// 主入口
// ============================================================

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const action = envelop.payload?.action ?? "read_file";
  let params = envelop.payload?.params ?? {};
  if (Object.keys(params).length === 0) {
    params = { ...envelop.payload };
    delete params.action;
  }

  try {
    // ============================================================
    // read_file
    // ============================================================
    if (action === "read_file") {
      const rawPath = params.path;
      if (!rawPath) return err(envelop, "缺少 path 参数");

      const path = resolvePath(rawPath);
      if (!existsSync(path)) return err(envelop, `文件不存在: ${rawPath}`);

      const fileStat = await stat(path);
      if (!fileStat.isFile()) return err(envelop, `路径不是文件: ${rawPath}`);

      const fileSize = fileStat.size;

      if (fileSize <= MAX_INLINE_SIZE) {
        const content = await readFile(path, "utf-8");
        envelop.payload = {
          ok: true,
          data: {
            path: displayPath(path),
            content,
            size: fileSize,
            size_kb: Math.round((fileSize / 1024) * 10) / 10,
            truncated: false,
          },
        };
        return envelop;
      }

      const content = await readFile(path, "utf-8");
      const totalLines = content.split("\n").length;
      const tail = content.slice(-MAX_INLINE_SIZE);
      const tailLines = tail.split("\n");
      const previewStartLine = totalLines - tailLines.length + 1;
      const previewBytes = Buffer.byteLength(tail, "utf-8");

      envelop.payload = {
        ok: true,
        data: {
          path: displayPath(path),
          preview: tail,
          size: fileSize,
          size_kb: Math.round((fileSize / 1024) * 10) / 10,
          total_lines: totalLines,
          preview_start_line: previewStartLine,
          preview_lines: tailLines.length,
          preview_bytes: previewBytes,
          preview_kb: Math.round((previewBytes / 1024) * 10) / 10,
          truncated: true,
          hint: `文件超过 100KB（${Math.round((fileSize / 1024) * 10) / 10}KB），只返回最后 ${Math.round((previewBytes / 1024) * 10) / 10}KB 内容（${tailLines.length} 行）。如需读取指定范围，请使用 read_file_lines（path, start_line, end_line）`,
        },
      };
      return envelop;
    }

    // ============================================================
    // read_file_lines
    // ============================================================
    if (action === "read_file_lines") {
      const rawPath = params.path;
      if (!rawPath) return err(envelop, "缺少 path 参数");

      const path = resolvePath(rawPath);
      if (!existsSync(path)) return err(envelop, `文件不存在: ${rawPath}`);

      const fileStat = await stat(path);
      if (!fileStat.isFile()) return err(envelop, `路径不是文件: ${rawPath}`);

      const content = await readFile(path, "utf-8");
      const lines = content.split("\n");
      const totalLines = lines.length;

      let start = params.start_line ?? 1;
      let end = params.end_line ?? totalLines;
      const withLineNum = params.with_line_num === true;

      if (typeof start !== "number" || start < 1) start = 1;
      if (typeof end !== "number" || end > totalLines) end = totalLines;
      if (start > end) {
        return err(envelop, `起始行 ${start} 大于结束行 ${end}，文件总行数: ${totalLines}`);
      }

      const selected = lines.slice(start - 1, end);

      if (withLineNum) {
        const result = selected.map((line, i) => ({
          line_num: start + i,
          content: line,
        }));
        envelop.payload = {
          ok: true,
          data: {
            path: displayPath(path),
            lines: result,
            total_lines: totalLines,
            start,
            end,
            returned: selected.length,
            with_line_num: true,
          },
        };
        return envelop;
      }

      envelop.payload = {
        ok: true,
        data: {
          path: displayPath(path),
          lines: selected,
          total_lines: totalLines,
          start,
          end,
          returned: selected.length,
          with_line_num: false,
        },
      };
      return envelop;
    }

    // ============================================================
    // write_file
    // ============================================================
    if (action === "write_file") {
      const rawPath = params.path;
      const content = params.content ?? "";
      if (!rawPath) return err(envelop, "缺少 path 参数");
      if (typeof content !== "string") return err(envelop, "content 必须是字符串");

      const path = resolvePath(rawPath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf-8");

      const f = Bun.file(path);
      if (!(await f.exists())) return err(envelop, "写入失败: 文件未创建");

      envelop.payload = { ok: true, data: { path: displayPath(path), size: f.size } };
      return envelop;
    }

    // ============================================================
    // append_file
    // ============================================================
    if (action === "append_file") {
      const rawPath = params.path;
      const content = params.content ?? "";
      if (!rawPath) return err(envelop, "缺少 path 参数");
      if (typeof content !== "string") return err(envelop, "content 必须是字符串");

      const path = resolvePath(rawPath);
      await mkdir(dirname(path), { recursive: true });
      if (existsSync(path)) {
        const old = await readFile(path, "utf-8");
        await writeFile(path, old + content, "utf-8");
      } else {
        await writeFile(path, content, "utf-8");
      }
      envelop.payload = { ok: true, data: { path: displayPath(path), appended: true } };
      return envelop;
    }

    // ============================================================
    // edit_file
    // ============================================================
    if (action === "edit_file") {
      const rawPath = params.path;
      const find = params.find;
      const replace = params.replace ?? "";
      if (!rawPath) return err(envelop, "缺少 path 参数");
      if (!find || typeof find !== "string") return err(envelop, "缺少 find 参数");
      if (typeof replace !== "string") return err(envelop, "replace 必须是字符串");

      const path = resolvePath(rawPath);
      if (!existsSync(path)) return err(envelop, `文件不存在: ${rawPath}`);

      const content = await readFile(path, "utf-8");
      const idx = content.indexOf(find);
      if (idx === -1) return err(envelop, `find 不匹配（前 50 字: ${find.slice(0, 50)}）`);
      const secondIdx = content.indexOf(find, idx + 1);
      if (secondIdx !== -1) return err(envelop, `find 不唯一，匹配到多个位置，请扩长 find 字符串`);

      const newContent = content.slice(0, idx) + replace + content.slice(idx + find.length);
      await writeFile(path, newContent, "utf-8");

      envelop.payload = {
        ok: true,
        data: {
          path: displayPath(path),
          replaced: true,
          old_size: content.length,
          new_size: newContent.length,
        },
      };
      return envelop;
    }

    // ============================================================
    // apply_patch
    // ============================================================
    if (action === "apply_patch") {
      const rawPath = params.path;
      const patch = params.content;
      if (!rawPath) return err(envelop, "缺少 path 参数");
      if (!patch || typeof patch !== "string") return err(envelop, "缺少 content 参数");

      const path = resolvePath(rawPath);
      if (!existsSync(path)) return err(envelop, `文件不存在: ${rawPath}`);

      const content = await readFile(path, "utf-8");
      const result = applyPatch(content, patch);

      if (!result.ok) return err(envelop, result.error ?? "patch 应用失败");

      await writeFile(path, result.result!, "utf-8");

      envelop.payload = {
        ok: true,
        data: {
          path: displayPath(path),
          patched: true,
          old_size: content.length,
          new_size: result.result!.length,
        },
      };
      return envelop;
    }

    // ============================================================
    // list_dir
    // ============================================================
    if (action === "list_dir") {
      const rawPath = params.path ?? ".";
      const path = resolvePath(rawPath);
      if (!existsSync(path)) return err(envelop, `目录不存在: ${rawPath}`);
      const entries = await readdir(path, { withFileTypes: true });
      const files = await Promise.all(
        entries.map(async (e) => {
          const fullPath = join(path, e.name);
          let size = 0;
          if (e.isFile()) {
            try {
              size = (await stat(fullPath)).size;
            } catch {
              /* ignore */
            }
          }
          return {
            name: e.name,
            type: e.isDirectory() ? "directory" : "file",
            size,
          };
        })
      );
      envelop.payload = { ok: true, data: { path: displayPath(path), files } };
      return envelop;
    }

    // ============================================================
    // delete_file
    // ============================================================
    if (action === "delete_file") {
      const rawPath = params.path;
      if (!rawPath) return err(envelop, "缺少 path 参数");

      const path = resolvePath(rawPath);
      if (!existsSync(path)) return err(envelop, `路径不存在: ${rawPath}`);
      await rm(path, { force: true, recursive: true });
      envelop.payload = { ok: true, data: { path: displayPath(path), deleted: true } };
      return envelop;
    }

    // ============================================================
    // exists
    // ============================================================
    if (action === "exists") {
      const rawPath = params.path;
      if (!rawPath) return err(envelop, "缺少 path 参数");
      const path = resolvePath(rawPath);
      envelop.payload = { ok: true, data: { path: displayPath(path), exists: existsSync(path) } };
      return envelop;
    }

    // ============================================================
    // file_stat
    // ============================================================
    if (action === "file_stat") {
      const rawPath = params.path;
      if (!rawPath) return err(envelop, "缺少 path 参数");

      const path = resolvePath(rawPath);
      if (!existsSync(path)) return err(envelop, `路径不存在: ${rawPath}`);

      const s = await stat(path);
      envelop.payload = {
        ok: true,
        data: {
          stat: {
            name: path.split(/[\\/]/).pop() ?? path,
            type: s.isDirectory() ? "directory" : "file",
            size: s.size,
            modified_at: s.mtime.toISOString(),
            created_at: s.birthtime.toISOString(),
          },
        },
      };
      return envelop;
    }

    // ============================================================
    // mkdir
    // ============================================================
    if (action === "mkdir") {
      const rawPath = params.path;
      if (!rawPath) return err(envelop, "缺少 path 参数");
      const path = resolvePath(rawPath);
      await mkdir(path, { recursive: true });
      envelop.payload = { ok: true, data: { path: displayPath(path), created: true } };
      return envelop;
    }

    envelop.payload = { ok: false, error: `未知 action: ${action}` };
    return envelop;
  } catch (e: any) {
    envelop.payload = { ok: false, error: `执行失败: ${e?.message ?? e}` };
    return envelop;
  }
}

// ============================================================
// help
// ============================================================

export function help() {
  return {
    route: "os/file_utils_api",
    description:
      "文件读写工具，支持读/按行读/写/追加/局部替换/补丁/列目录/删除/检查存在/文件属性/建目录。所有相对路径锚定项目根。",
    input: {
      action:
        "read_file | read_file_lines | write_file | append_file | edit_file | apply_patch | list_dir | delete_file | exists | file_stat | mkdir",
      path: "文件或目录路径（相对路径锚定项目根）",
      content: "写入内容 / patch 内容（write_file / append_file / apply_patch）",
      find: "要查找的旧内容（edit_file，必须唯一匹配）",
      replace: "新内容（edit_file）",
      start_line: "起始行号，从 1 开始（read_file_lines）",
      end_line: "结束行号（read_file_lines，含）",
      with_line_num: "是否返回行号，默认 false（read_file_lines）",
    },
    output: {
      ok: "boolean",
      data: "object",
      error: "string",
    },
  };
}
