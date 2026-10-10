/**
 * fix_tool — 修复已有应用
 *
 * 输入：target（项目名 / 路径）+ issue（修复需求，自然语言）
 *
 * 流程：
 *   1. 解析 target → 项目名
 *   2. 读项目现状（后端代码 + 前端 HTML）
 *   3. fix_design → 修复方案（mode + scope + 具体文件 + 具体改动）
 *   4. 按 mode 分流：
 *      - local：走 fix_backend / fix_frontend（局部修）
 *      - regenerate：走 generate_backend / generate_frontend（带现有代码）
 *   5. 原子写
 *   6. 等 watcher 重载
 *   7. 返回
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Envelop } from "../../../core/Envelop.js";
import type { Agent } from "../../../core/Agent.js";
import { atomicWrite } from "../../../runtime/atomic_write.js";

import {
  FIX_DESIGN_SYSTEM,
  FIX_DESIGN_USER_TEMPLATE,
} from "../engine/fix_design.js";
import {
  FIX_BACKEND_SYSTEM,
  FIX_BACKEND_USER_TEMPLATE,
} from "../engine/fix_backend.js";
import {
  FIX_FRONTEND_SYSTEM,
  FIX_FRONTEND_USER_TEMPLATE,
} from "../engine/fix_frontend.js";
import {
  GENERATE_BACKEND_SYSTEM,
  GENERATE_BACKEND_USER_TEMPLATE,
} from "../engine/generate_backend.js";
import {
  GENERATE_FRONTEND_SYSTEM,
  GENERATE_FRONTEND_USER_TEMPLATE,
} from "../engine/generate_frontend.js";

// ============================================================
// 常量
// ============================================================

const PROJECTS_DIR = "src/plugins/applications";
const WWW_HTML_DIR = "www";
const MAX_BACKEND_SOURCE_CHARS = 30000;
const MAX_FILE_SUMMARY_CHARS = 2000;

// ============================================================
// WS 推送
// ============================================================

async function pushCode(agent: Agent, sessionId: string, chunk: string): Promise<void> {
  try {
    const env = new Envelop({
      sender: "builtins/tools/fix_tool",
      receiver: "os/_websocket",
      payload: {
        action: "push",
        channel_id: "pa_" + sessionId,
        data: {
          type: "code_stream",
          chunk: chunk,
        },
      },
    });
    await agent.system.call(env);
  } catch {
    // 推送失败不影响主流程
  }
}

async function pushProgress(
  agent: Agent,
  sessionId: string,
  step: string,
  msg: string
): Promise<void> {
  try {
    const env = new Envelop({
      sender: "builtins/tools/fix_tool",
      receiver: "os/_websocket",
      payload: {
        action: "push",
        channel_id: "pa_" + sessionId,
        data: {
          type: "progress",
          step: step,
          msg: msg,
          message: msg,
        },
      },
    });
    await agent.system.call(env);
  } catch {
    // 推送失败不影响主流程
  }
}

// ============================================================
// 流式 LLM 调用
// ============================================================

async function streamLLM(
  agent: Agent,
  messages: Array<{ role: string; content: string }>,
  sessionId: string
): Promise<string> {
  if (!agent.llm) throw new Error("LLM 未配置");

  let buffer = "";
  for await (const delta of agent.llm.chat_stream(messages as any, undefined, "code")) {
    if (delta) {
      buffer += delta;
      await pushCode(agent, sessionId, delta);
    }
  }
  return buffer;
}

// ============================================================
// HTML 续写
// ============================================================

async function continueHtml(
  agent: Agent,
  partialHtml: string,
  sessionId: string,
  maxContinuations: number = 3
): Promise<string> {
  if (!agent.llm) throw new Error("LLM 未配置");

  let html = partialHtml;

  for (let attempt = 0; attempt < maxContinuations; attempt++) {
    const lower = html.trim().toLowerCase();

    if (lower.endsWith("</html>")) {
      return html;
    }

    if (lower.includes("</body>")) {
      return html.trimEnd() + "\n</html>";
    }

    const prompt = `【HTML 被截断了，请从断点续写到 </html>】

以下是**完整的已生成 HTML**（从头到断点）：

\`\`\`html
${html}
\`\`\`

【续写规则】
1. 从断点（最后一行）继续写，不要重复已有内容
2. **必须沿用上面已有的所有命名**：
   - 函数名（如 formatDeadline、handleCoverUpload 等）
   - 变量名（如 currentVoteId、selectedOptionIndex 等）
   - HTML 元素 ID（如 voteGrid、detailView、optionsList 等）
   - CSS 类名
3. 如果上面的代码"引用了某个函数但还没定义"，你在这里定义它（用**相同的名字**）
4. 如果上面的代码"引用了某个元素 ID 但 HTML 里没有"，你要在续写的 JS 里用**相同的 ID** 或说明该 ID 应在哪里
5. 写完所有剩余内容后，依次闭合 \`</script>\`、\`</body>\`、\`</html>\`
6. 直接输出续写内容，不要重复 <!DOCTYPE html>、<html>、<head>、<style> 等

只输出从断点开始的续写内容（不要重复前面的代码）。`;

    let continuation = "";
    try {
      for await (const delta of agent.llm.chat_stream(
        [{ role: "user", content: prompt }] as any,
        undefined,
        "code"
      )) {
        if (delta) {
          continuation += delta;
          await pushCode(agent, sessionId, delta);
        }
      }
    } catch (e) {
      console.warn("[continueHtml] LLM call failed:", e);
      return html;
    }

    if (!continuation) {
      return html;
    }

    // 清理代码块标记
    continuation = continuation.trim();
    for (const prefix of ["```html", "```javascript", "```js", "```"]) {
      if (continuation.startsWith(prefix)) {
        continuation = continuation.slice(prefix.length);
        break;
      }
    }
    for (const suffix of ["```", "~~~"]) {
      if (continuation.endsWith(suffix)) {
        continuation = continuation.slice(0, -suffix.length);
        break;
      }
    }
    continuation = continuation.trim();

    // 移除可能的 html_content = '''...''' 包裹
    const m = continuation.match(/html_content\s*=\s*['"]{3}([\s\S]*?)['"]{3}/);
    if (m) {
      continuation = m[1].trim();
    }

    // ★★★ 关键：重叠检测 + 去重 ★★★
    // 找"续写内容" 和 "前半段结尾" 的最长重叠
    let overlapLen = 0;
    const maxCheck = Math.min(html.length, continuation.length);
    for (let i = maxCheck; i >= 8; i--) {   // 至少 8 字符才算"重叠"
      const tail = html.slice(-i);
      if (continuation.startsWith(tail)) {
        overlapLen = i;
        break;
      }
    }

    if (overlapLen > 0) {
      console.log(`[continueHtml] 检测到重叠 ${overlapLen} 字符，去重`);
      continuation = continuation.slice(overlapLen);
    }

    html = html + continuation;

    // ★ 修复"粘连"（`var optionsvar inputElements` 这种）
    html = html.replace(/(var\s+\w+)\s*(var\s+\w+)/g, "$1;\n$2");
    html = html.replace(/(if\s*\([^)]+\))\s*(if\s*\([^)]+\))/g, "$1;\n$2");
    html = html.replace(/(function\s*\w*\s*\([^)]*\)\s*\{?)\s*(function\s*\w*\s*\()/g, "$1\n$2");

    await pushProgress(
      agent, sessionId, "executing",
      `HTML 续写完成（第 ${attempt + 1} 次），当前 ${html.length} 字`
    );
  }

  return html;
}
// ============================================================
// 工具函数
// ============================================================

function extractPluginBlock(raw: string): string | null {
  const m = raw.match(/=== PLUGIN:\s*[^=]+===\s*\n([\s\S]*?)=== END ===/);
  if (m) return m[1].trim();
  return null;
}

function extractHtmlBlock(raw: string): string | null {
  const m = raw.match(/=== HTML:\s*[^=]+===\s*\n([\s\S]*?)=== END ===/);
  if (m) return m[1].trim();
  const m2 = raw.match(/(<!DOCTYPE html>[\s\S]*?<\/html>)/i);
  if (m2) return m2[1].trim();
  return null;
}

async function extractHtmlWithContinuation(
  agent: Agent,
  raw: string,
  sessionId: string
): Promise<string> {
  let html = extractHtmlBlock(raw);

  if (!html) {
    const looseMatch = raw.match(/(<!DOCTYPE html>[\s\S]*)$/i);
    if (looseMatch) {
      html = looseMatch[1];
    } else {
      throw new Error("无法提取 HTML 代码");
    }
  }

  const lower = html.trim().toLowerCase();

  if (!lower.includes("<!doctype")) {
    throw new Error("HTML 缺少 <!DOCTYPE>");
  }

  if (lower.endsWith("</html>")) {
    return html;
  }

  if (lower.includes("</body>")) {
    return html.trimEnd() + "\n</html>";
  }

  await pushProgress(agent, sessionId, "executing", "HTML 被截断，正在续写...");
  html = await continueHtml(agent, html, sessionId);

  const finalLower = html.trim().toLowerCase();
  if (!finalLower.endsWith("</html>")) {
    if (finalLower.includes("</body>")) {
      html = html.trimEnd() + "\n</html>";
    } else {
      throw new Error("HTML 续写后仍不完整");
    }
  }

  return html;
}

// ============================================================
// 项目解析
// ============================================================

function parseProjectName(target: string): string {
  if (target.includes("applications/")) {
    const after = target.split("applications/").pop() ?? "";
    return after.split("/")[0] ?? "";
  }
  if (target.startsWith("www/")) {
    const after = target.slice(4);
    return after.split("/")[0] ?? "";
  }
  return target.trim();
}

async function findBackendFiles(
  projectName: string
): Promise<Array<{ path: string; fileName: string }>> {
  const backendDir = join(PROJECTS_DIR, projectName);
  if (!existsSync(backendDir)) return [];

  try {
    const files = await readdir(backendDir);
    const tsFiles = files.filter(
      (f) =>
        f.endsWith(".ts") &&
        !f.endsWith(".d.ts") &&
        !f.endsWith(".tmp") &&
        !f.endsWith(".contract.json")
    );
    return tsFiles.map((f) => ({
      path: join(backendDir, f),
      fileName: f,
    }));
  } catch {
    return [];
  }
}

async function collectBackendSource(projectName: string): Promise<string> {
  const files = await findBackendFiles(projectName);
  if (files.length === 0) return "";

  const parts: string[] = [];
  for (const f of files) {
    try {
      const code = await readFile(f.path, "utf-8");
      parts.push(`=== ${f.fileName} ===\n${code}`);
    } catch {}
  }

  let combined = parts.join("\n\n");
  if (combined.length > MAX_BACKEND_SOURCE_CHARS) {
    combined =
      combined.slice(0, MAX_BACKEND_SOURCE_CHARS) +
      "\n\n... (后端源码过长，已截断)";
  }
  return combined;
}

function extractFileSummary(code: string): string {
  const lines = code.split("\n");
  const parts: string[] = [];

  const head = lines.slice(0, 15).join("\n");
  const commentMatch = head.match(/\/\*\*([\s\S]*?)\*\//);
  if (commentMatch) {
    const comment = commentMatch[1]
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/, "").trim())
      .filter((l) => l)
      .slice(0, 5)
      .join(" | ");
    if (comment) parts.push(`注释: ${comment}`);
  }

  const exports: string[] = [];
  const exportRe = /export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = exportRe.exec(code)) !== null) {
    exports.push(m[1]);
  }
  if (exports.length > 0) {
    parts.push(`导出: ${exports.join(", ")}`);
  }

  if (parts.length === 0) {
    parts.push(lines.slice(0, 10).join("\n"));
  }

  let summary = parts.join("\n");
  if (summary.length > MAX_FILE_SUMMARY_CHARS) {
    summary = summary.slice(0, MAX_FILE_SUMMARY_CHARS) + "...";
  }
  return summary;
}

async function collectBackendFileInfos(
  projectName: string
): Promise<Array<{ fileName: string; summary: string }>> {
  const files = await findBackendFiles(projectName);
  const result: Array<{ fileName: string; summary: string }> = [];
  for (const f of files) {
    try {
      const code = await readFile(f.path, "utf-8");
      result.push({
        fileName: f.fileName,
        summary: extractFileSummary(code),
      });
    } catch {
      result.push({ fileName: f.fileName, summary: "(读取失败)" });
    }
  }
  return result;
}

// ============================================================
// LLM 调用
// ============================================================

async function callFixDesign(
  agent: Agent,
  projectName: string,
  issue: string,
  backendFileInfos: Array<{ fileName: string; summary: string }>,
  backendExists: boolean,
  frontendExists: boolean,
  backendSource: string
): Promise<any> {
  if (!agent.llm) throw new Error("LLM 未配置");

  const result = await agent.llm.chat_json(
    [
      { role: "system", content: FIX_DESIGN_SYSTEM },
      {
        role: "user",
        content: FIX_DESIGN_USER_TEMPLATE(
          projectName,
          issue,
          backendFileInfos,
          backendExists,
          frontendExists,
          backendSource
        ),
      },
    ],
    undefined,
    "code"
  );

  if (result?.error) throw new Error(`fix_design 失败: ${result.error}`);
  if (!result?.scope) throw new Error("fix_design 返回缺少 scope");
  if (!result?.mode) result.mode = "regenerate";
  return result;
}

async function callFixBackend(
  agent: Agent,
  projectName: string,
  backendFileName: string,
  issue: string,
  currentCode: string,
  backendChanges: any[],
  sessionId: string
): Promise<string> {
  if (!agent.llm) throw new Error("LLM 未配置");

  const raw = await streamLLM(
    agent,
    [
      { role: "system", content: FIX_BACKEND_SYSTEM },
      {
        role: "user",
        content: FIX_BACKEND_USER_TEMPLATE(
          projectName,
          backendFileName,
          issue,
          currentCode,
          backendChanges
        ),
      },
    ],
    sessionId
  );

  const code = extractPluginBlock(raw);
  if (!code) throw new Error("无法提取后端代码");
  return code;
}

async function callFixFrontend(
  agent: Agent,
  projectName: string,
  issue: string,
  currentHtml: string,
  backendSource: string,
  frontendChanges: any[],
  sessionId: string
): Promise<string> {
  if (!agent.llm) throw new Error("LLM 未配置");

  const raw = await streamLLM(
    agent,
    [
      { role: "system", content: FIX_FRONTEND_SYSTEM },
      {
        role: "user",
        content: FIX_FRONTEND_USER_TEMPLATE(
          projectName,
          issue,
          currentHtml,
          backendSource,
          frontendChanges
        ),
      },
    ],
    sessionId
  );

  // ★ 提取 + 续写
  const html = await extractHtmlWithContinuation(agent, raw, sessionId);
  return html;
}

async function callGenerateBackend(
  agent: Agent,
  projectName: string,
  pluginSpec: any,
  issue: string,
  currentCode: string,
  sessionId: string
): Promise<string> {
  if (!agent.llm) throw new Error("LLM 未配置");

  const raw = await streamLLM(
    agent,
    [
      { role: "system", content: GENERATE_BACKEND_SYSTEM },
      {
        role: "user",
        content: GENERATE_BACKEND_USER_TEMPLATE(
          { description: issue },
          pluginSpec,
          projectName,
          currentCode
        ),
      },
    ],
    sessionId
  );

  const code = extractPluginBlock(raw);
  if (!code) throw new Error("无法提取后端代码");
  return code;
}

async function callGenerateFrontend(
  agent: Agent,
  projectName: string,
  frontendSpec: any,
  issue: string,
  backendSource: string,
  apiPlugin: string,
  currentHtml: string,
  sessionId: string
): Promise<string> {
  if (!agent.llm) throw new Error("LLM 未配置");

  const raw = await streamLLM(
    agent,
    [
      { role: "system", content: GENERATE_FRONTEND_SYSTEM },
      {
        role: "user",
        content: GENERATE_FRONTEND_USER_TEMPLATE(
          { description: issue },
          frontendSpec,
          backendSource,
          projectName,
          apiPlugin,
          currentHtml
        ),
      },
    ],
    sessionId
  );

  // ★ 提取 + 续写
  const html = await extractHtmlWithContinuation(agent, raw, sessionId);
  return html;
}

// ============================================================
// 主入口
// ============================================================

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const action = envelop.payload?.action ?? "fix";

  let params = envelop.payload?.params ?? {};
  if (Object.keys(params).length === 0) {
    params = { ...envelop.payload };
    delete params.action;
  }

  if (action !== "fix") {
    envelop.payload = { ok: false, error: `未知 action: ${action}` };
    return envelop;
  }

  const target = params.target ?? "";
  const issue = params.issue ?? params.requirement ?? "";

  if (!target) {
    envelop.payload = { ok: false, error: "缺少 target 参数" };
    return envelop;
  }
  if (!issue) {
    envelop.payload = { ok: false, error: "缺少 issue 参数" };
    return envelop;
  }

  if (!agent.llm) {
    envelop.payload = { ok: false, error: "LLM 未配置" };
    return envelop;
  }

  // ★ sessionId（用于 WS 推送）
  const sessionId = (envelop.meta?.session_id as string) ?? "default";

  const projectName = parseProjectName(target);
  if (!projectName) {
    envelop.payload = { ok: false, error: `无法解析项目名: ${target}` };
    return envelop;
  }

  if (
    projectName.includes("..") ||
    projectName.includes("/") ||
    projectName.includes("\\")
  ) {
    envelop.payload = { ok: false, error: "项目名含非法字符" };
    return envelop;
  }

  const backendFiles = await findBackendFiles(projectName);
  const backendExists = backendFiles.length > 0;

  const htmlPath = join(WWW_HTML_DIR, projectName, "index.html");
  const frontendExists = existsSync(htmlPath);

  if (!backendExists && !frontendExists) {
    envelop.payload = { ok: false, error: `项目不存在: ${projectName}` };
    return envelop;
  }

  const currentHtml = frontendExists
    ? await readFile(htmlPath, "utf-8")
    : "";

  const backendSource = backendExists
    ? await collectBackendSource(projectName)
    : "";

  const backendFileInfos = backendExists
    ? await collectBackendFileInfos(projectName)
    : [];

  // ============================================================
  // 1. fix_design
  // ============================================================

  await pushProgress(agent, sessionId, "executing", "分析问题，设计修复方案...");

  let design: any;
  try {
    design = await callFixDesign(
      agent,
      projectName,
      issue,
      backendFileInfos,
      backendExists,
      frontendExists,
      backendSource
    );
  } catch (e: any) {
    envelop.payload = { ok: false, error: `修复方案设计失败: ${e.message}` };
    return envelop;
  }

  const mode = design.mode ?? "regenerate";
  const scope = design.scope;
  const backendChanges = design.backend_changes ?? [];
  const frontendChanges = design.frontend_changes ?? [];

  await pushProgress(
    agent,
    sessionId,
    "done",
    `修复方案：${mode} / ${scope}`
  );

  const writtenFiles: string[] = [];

  // ============================================================
  // 2. 按 mode 分流
  // ============================================================

  if (mode === "regenerate") {
    // ============================================================
    // 2A. 重生成：走 generate_*（带现有代码）
    // ============================================================

    if ((scope === "backend" || scope === "both") && backendExists) {
      for (const file of backendFiles) {
        const currentCode = await readFile(file.path, "utf-8");

        const spec = design.backend_spec ?? {
          name: file.fileName.replace(".ts", ""),
          description: issue,
        };

        await pushProgress(
          agent,
          sessionId,
          "executing",
          `重生成后端 ${file.fileName}...`
        );

        let newCode: string;
        try {
          newCode = await callGenerateBackend(
            agent,
            projectName,
            spec,
            issue,
            currentCode,
            sessionId
          );
        } catch (e: any) {
          envelop.payload = {
            ok: false,
            error: `重生成后端失败 (${file.fileName}): ${e.message}`,
          };
          return envelop;
        }

        const actualPath = await atomicWrite(file.path, newCode, projectName);
        writtenFiles.push(actualPath);

        await pushProgress(
          agent,
          sessionId,
          "done",
          `${file.fileName} 重生成完成（${newCode.length} 字）`
        );
      }
    }

    if ((scope === "frontend" || scope === "both") && frontendExists) {
      const freshBackendSource = await collectBackendSource(projectName);

      const spec = design.frontend_spec ?? {
        name: "index.html",
        description: issue,
      };

      const apiPlugin = backendFiles[0]?.fileName.replace(".ts", "") ?? "";

      await pushProgress(agent, sessionId, "executing", "重生成前端页面...");

      let newHtml: string;
      try {
        newHtml = await callGenerateFrontend(
          agent,
          projectName,
          spec,
          issue,
          freshBackendSource,
          apiPlugin,
          currentHtml,
          sessionId
        );
      } catch (e: any) {
        envelop.payload = {
          ok: false,
          error: `重生成前端失败: ${e.message}`,
        };
        return envelop;
      }

      const actualPath = await atomicWrite(htmlPath, newHtml, projectName);
      writtenFiles.push(actualPath);

      await pushProgress(agent, sessionId, "done", "前端页面重生成完成");
    }
  } else {
    // ============================================================
    // 2B. 局部改：走 fix_*
    // ============================================================

    if ((scope === "backend" || scope === "both") && backendExists) {
      for (const change of backendChanges) {
        const fileName = change.file;
        if (!fileName) {
          if (backendFiles.length === 0) continue;
          const fallback = backendFiles[0];
          const currentCode = await readFile(fallback.path, "utf-8");

          await pushProgress(
            agent,
            sessionId,
            "executing",
            `修复后端 ${fallback.fileName}...`
          );

          let newCode: string;
          try {
            newCode = await callFixBackend(
              agent,
              projectName,
              fallback.fileName,
              issue,
              currentCode,
              [change],
              sessionId
            );
          } catch (e: any) {
            envelop.payload = {
              ok: false,
              error: `修复后端失败 (${fallback.fileName}): ${e.message}`,
            };
            return envelop;
          }
          const actualPath = await atomicWrite(fallback.path, newCode, projectName);
          writtenFiles.push(actualPath);

          await pushProgress(
            agent,
            sessionId,
            "done",
            `${fallback.fileName} 修复完成`
          );
          continue;
        }

        const filePath = join(PROJECTS_DIR, projectName, fileName);
        if (!existsSync(filePath)) {
          envelop.payload = {
            ok: false,
            error: `后端文件不存在: ${fileName}`,
          };
          return envelop;
        }
        const currentCode = await readFile(filePath, "utf-8");

        await pushProgress(
          agent,
          sessionId,
          "executing",
          `修复后端 ${fileName}...`
        );

        let newCode: string;
        try {
          newCode = await callFixBackend(
            agent,
            projectName,
            fileName,
            issue,
            currentCode,
            [change],
            sessionId
          );
        } catch (e: any) {
          envelop.payload = {
            ok: false,
            error: `修复后端失败 (${fileName}): ${e.message}`,
          };
          return envelop;
        }
        const actualPath = await atomicWrite(filePath, newCode, projectName);
        writtenFiles.push(actualPath);

        await pushProgress(agent, sessionId, "done", `${fileName} 修复完成`);
      }
    }

    if ((scope === "frontend" || scope === "both") && frontendExists) {
      const useBackendSource =
        scope === "both"
          ? await collectBackendSource(projectName)
          : backendSource;

      await pushProgress(agent, sessionId, "executing", "修复前端页面...");

      let newHtml: string;
      try {
        newHtml = await callFixFrontend(
          agent,
          projectName,
          issue,
          currentHtml,
          useBackendSource,
          frontendChanges,
          sessionId
        );
      } catch (e: any) {
        envelop.payload = { ok: false, error: `修复前端失败: ${e.message}` };
        return envelop;
      }

      try {
        const actualPath = await atomicWrite(htmlPath, newHtml, projectName);
        writtenFiles.push(actualPath);
        await pushProgress(agent, sessionId, "done", "前端页面修复完成");
      } catch (e: any) {
        envelop.payload = { ok: false, error: `写入前端失败: ${e.message}` };
        return envelop;
      }
    }
  }

  // ============================================================
  // 3. 等 watcher 重载
  // ============================================================

  await pushProgress(agent, sessionId, "executing", "等待热加载编译...");

  await new Promise((r) => setTimeout(r, 3000));

  // ============================================================
  // 4. 返回
  // ============================================================

  const url = frontendExists ? `/${projectName}/` : "";

  envelop.payload = {
    ok: true,
    data: {
      project_name: projectName,
      mode,
      scope,
      reason: design.reason ?? "",
      files: writtenFiles,
      backend_changes: backendChanges,
      frontend_changes: frontendChanges,
      url,
    },
    message: `✅ 修复完成：${projectName}\n模式：${mode}\n范围：${scope}${url ? `\n访问：${url}` : ""}`,
  };
  return envelop;
}

// ============================================================
// help
// ============================================================

export function help() {
  return {
    route: "builtins/tools/fix_tool",
    description: "修复已有应用（local 局部改 / regenerate 重生成）",
    input: {
      action: "fix（默认）",
      target: "项目名（如 task_board）或路径",
      issue: "修复需求（自然语言）",
    },
    output: {
      ok: "是否成功",
      data: {
        project_name: "项目名",
        mode: "local | regenerate",
        scope: "backend | frontend | both",
        reason: "判断依据",
        files: "修改的文件列表",
        backend_changes: "后端改动列表",
        frontend_changes: "前端改动列表",
        url: "前端访问地址",
      },
      message: "结果消息",
    },
  };
}
