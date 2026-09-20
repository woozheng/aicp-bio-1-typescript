/**
 * builtins/studio/api — Studio API（项目文件管理，需 token 鉴权）
 *
 * 与 Python 版 plugins/builtins/studio/api.py 对应。
 */

import { readFile, writeFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative, dirname, sep } from "node:path";
import { Envelop } from "../../../core/Envelop.js";
import type { Agent } from "../../../core/Agent.js";

// ============================================================
// 常量
// ============================================================

const APPS_DIR = "src/plugins/applications";
const WWW_DIR = "www";
const CACHE_DIR = "data/studio_cache";
const PROTOCOL_PATH = "src/plugins/builtins/studio/aicp.md";

// ============================================================
// 路径检查
// ============================================================
// ============================================================
// 工具：递归扫描目录
// ============================================================

async function walkInto(
  root: string,
  base: string,
  appId: string,
  label: string,
  out: any[]
): Promise<void> {
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "__pycache__") continue;
      if (entry.name === ".git") continue;
      if (entry.name === "__init__.py") continue;
      if (entry.name.endsWith(".pyc")) continue;

      const full = join(dir, entry.name);
      const rel = relative(root, full).replace(/\\/g, "/");
      out.push({
        name: rel,
        dir: entry.isDirectory(),
        path: `${base}/${appId}/${rel}`.replace(/\\/g, "/"),
      });

      if (entry.isDirectory()) {
        await walk(full);
      }
    }
  }
  await walk(root);
}
const WWW_PLUGINS_DIR = "src/plugins/www";

function isAllowedPath(fullPath: string): boolean {
  const resolved = resolve(fullPath);
  const allowed = [
    resolve(APPS_DIR),          // src/plugins/applications
    resolve(WWW_DIR),           // www
    resolve(CACHE_DIR),         // data/studio_cache
    resolve(WWW_PLUGINS_DIR),   // ★ src/plugins/www
  ];
  return allowed.some((p) => resolved === p || resolved.startsWith(p + sep));
}

// ============================================================
// 主入口
// ============================================================

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  // 鉴权
  const studioToken = (agent as any).config?.studio_token ?? "";
  const token = envelop.payload?.token ?? "";

  if (!studioToken || token !== studioToken) {
    envelop.payload = { ok: false, error: "无权限" };
    return envelop;
  }

  const action = envelop.payload?.action ?? "";
  const appId = envelop.payload?.app_id ?? "";

  // ============================================================
  // list_projects
  // ============================================================
  if (action === "list_projects") {
  const projects = new Set<string>();

  // 1. src/plugins/applications/{名}/
  if (existsSync(APPS_DIR)) {
    try {
      const entries = await readdir(APPS_DIR, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith(".")) {
          projects.add(e.name);
        }
      }
    } catch { /* ignore */ }
  }

  // 2. src/plugins/www/{名}.ts
  const WWW_PLUGINS_DIR = "src/plugins/www";
  if (existsSync(WWW_PLUGINS_DIR)) {
    try {
      const entries = await readdir(WWW_PLUGINS_DIR, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith(".ts") && !e.name.startsWith("_")) {
          projects.add(e.name.replace(/\.ts$/, ""));
        }
      }
    } catch { /* ignore */ }
  }

  // 3. www/{名}/
  if (existsSync(WWW_DIR)) {
    try {
      const entries = await readdir(WWW_DIR, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("_")) {
          projects.add(e.name);
        }
      }
    } catch { /* ignore */ }
  }

  envelop.payload = { ok: true, projects: Array.from(projects).sort() };
  return envelop;
}

  // ============================================================
  // list_files
  // ============================================================
 if (action === "list_files") {
  if (!appId) {
    envelop.payload = { ok: false, error: "缺少 app_id" };
    return envelop;
  }

  const result: Record<string, any[]> = {
    plugins: [],   // src/plugins/applications/{app_id}/
    www_plugin: [], // src/plugins/www/{app_id}.ts
    www: [],        // www/{app_id}/
  };

  // 1. src/plugins/applications/{app_id}/
  {
    const root = join(APPS_DIR, appId);
    if (existsSync(root)) {
      await walkInto(root, APPS_DIR, appId, "plugins", result.plugins);
    }
  }

  // 2. src/plugins/www/{app_id}.ts
  {
    const pluginPath = join("src/plugins/www", `${appId}.ts`);
    if (existsSync(pluginPath)) {
      result.www_plugin.push({
        name: `${appId}.ts`,
        dir: false,
        path: pluginPath.replace(/\\/g, "/"),
      });
    }
  }

  // 3. www/{app_id}/
  {
    const root = join(WWW_DIR, appId);
    if (existsSync(root)) {
      await walkInto(root, WWW_DIR, appId, "www", result.www);
    }
  }

  envelop.payload = { ok: true, tree: result };
  return envelop;
}

  // ============================================================
  // read_file
  // ============================================================
  if (action === "read_file") {
    const path = envelop.payload?.path ?? "";
    if (!path) {
      envelop.payload = { ok: false, error: "缺少 path" };
      return envelop;
    }

    const full = resolve(path);
    if (!isAllowedPath(full)) {
      envelop.payload = { ok: false, error: "路径越权" };
      return envelop;
    }

    if (!existsSync(full)) {
      envelop.payload = { ok: false, error: "文件不存在" };
      return envelop;
    }

    const st = await stat(full);
    if (st.isDirectory()) {
      envelop.payload = { ok: false, error: "文件不存在" };
      return envelop;
    }

    try {
      const content = await readFile(full, "utf-8");
      envelop.payload = { ok: true, content };
    } catch (e: any) {
      envelop.payload = { ok: false, error: `读取失败: ${e?.message ?? e}` };
    }
    return envelop;
  }

  // ============================================================
  // write_file
  // ============================================================
  if (action === "write_file") {
    const path = envelop.payload?.path ?? "";
    const content = envelop.payload?.content ?? "";
    if (!path) {
      envelop.payload = { ok: false, error: "缺少 path" };
      return envelop;
    }

    const full = resolve(path);
    if (!isAllowedPath(full)) {
      envelop.payload = { ok: false, error: "路径越权" };
      return envelop;
    }

    try {
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, "utf-8");
      envelop.payload = { ok: true, path: full };
    } catch (e: any) {
      envelop.payload = { ok: false, error: `写入失败: ${e?.message ?? e}` };
    }
    return envelop;
  }

  // ============================================================
  // delete_file
  // ============================================================
  if (action === "delete_file") {
    const path = envelop.payload?.path ?? "";
    if (!path) {
      envelop.payload = { ok: false, error: "缺少 path" };
      return envelop;
    }

    const full = resolve(path);
    if (!isAllowedPath(full)) {
      envelop.payload = { ok: false, error: "路径越权" };
      return envelop;
    }

    if (existsSync(full)) {
      const st = await stat(full);
      if (st.isDirectory()) {
        await rm(full, { recursive: true, force: true });
      } else {
        await rm(full, { force: true });
      }
    }
    envelop.payload = { ok: true };
    return envelop;
  }

 

  // ============================================================
  // save_blocks
  // ============================================================
  if (action === "save_blocks") {
    const text = envelop.payload?.text ?? "";
    if (!text) {
      envelop.payload = { ok: false, error: "缺少 text" };
      return envelop;
    }

    // ★ 调 saver 统一处理
    const result = await agent.system.call(new Envelop({
      sender: "builtins/studio/api",
      receiver: "os/saver",
      payload: {
        action: "save",
        text,
        app_id: appId,
      },
    }));

    envelop.payload = {
      ok: result?.payload?.ok ?? false,
      saved: result?.payload?.saved ?? [],
      count: result?.payload?.count ?? 0,
      errors: result?.payload?.errors ?? [],
      error: result?.payload?.error,
    };
    return envelop;
  }

  // ============================================================
  // get_protocol
  // ============================================================
  if (action === "get_protocol") {
    if (existsSync(PROTOCOL_PATH)) {
      try {
        const protocol = await readFile(PROTOCOL_PATH, "utf-8");
        envelop.payload = { ok: true, protocol };
      } catch (e: any) {
        envelop.payload = { ok: false, error: `读取协议失败: ${e?.message ?? e}` };
      }
    } else {
      envelop.payload = { ok: false, error: "协议文件不存在" };
    }
    return envelop;
  }

  envelop.payload = { ok: false, error: `未知操作: ${action}` };
  return envelop;
}

// ============================================================
// help
// ============================================================

export function help() {
  return {
    route: "builtins/studio/api",
    description: "Studio API — 项目文件管理（需 token 鉴权）",
    actions: {
      list_projects: "列出所有项目",
      list_files: "列出项目文件树",
      read_file: "读文件",
      write_file: "写文件",
      delete_file: "删文件",
      save_blocks: "保存 AI 输出的代码块",
      get_protocol: "获取协议内容",
    },
    input: {
      token: "Studio Token（必填）",
      action: "required",
      app_id: "项目名（list_files / save_blocks 时）",
      path: "文件路径（read / write / delete 时）",
      content: "文件内容（write 时）",
      text: "AI 输出文本（save_blocks 时）",
    },
  };
}