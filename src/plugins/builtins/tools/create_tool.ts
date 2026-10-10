/**
 * create_tool — 创建新应用（一把梭）
 *
 * 流程：
 *   1. design → 架构 JSON（同步）
 *   2. 逐个 generate_backend → TS 代码（流式，每 chunk 推 WS）
 *   3. 收集后端源码（传给前端对齐字段）
 *   4. generate_frontend → HTML（流式 + 续写）
 *   5. 原子写所有文件
 *   6. 等 watcher 加载
 *   7. 查 plugins Map 验证
 */

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { Envelop } from "../../../core/Envelop.js";
import { plugins } from "../../../core/plugins.js";
import type { Agent } from "../../../core/Agent.js";
import { atomicWrite } from "../../../runtime/atomic_write.js";

import { DESIGN_SYSTEM, DESIGN_USER_TEMPLATE } from "../engine/design.js";
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

// ============================================================
// WS 推送
// ============================================================

async function pushCode(agent: Agent, sessionId: string, chunk: string): Promise<void> {
  try {
    const env = new Envelop({
      sender: "builtins/tools/create_tool",
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
      sender: "builtins/tools/create_tool",
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

function extractPluginBlock(raw: string, pluginName: string): string | null {
  const pattern = new RegExp(
    `=== PLUGIN:\\s*[^=]*${escapeRegex(pluginName)}\\s*===\\s*\\n([\\s\\S]*?)=== END ===`,
    "i"
  );
  let m = raw.match(pattern);
  if (m) return m[1].trim();

  m = raw.match(/=== PLUGIN:\s*[^=]+===\s*\n([\s\S]*?)=== END ===/);
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
  // 1. 标准提取
  let html = extractHtmlBlock(raw);

  // 2. 宽松提取
  if (!html) {
    const looseMatch = raw.match(/(<!DOCTYPE html>[\s\S]*)$/i);
    if (looseMatch) {
      html = looseMatch[1];
    } else {
      throw new Error("无法提取 HTML 代码");
    }
  }

  // 3. 检查完整性
  const lower = html.trim().toLowerCase();

  if (!lower.includes("<!doctype")) {
    throw new Error("HTML 缺少 <!DOCTYPE>");
  }

  if (lower.endsWith("</html>")) {
    return html; // 完整
  }

  if (lower.includes("</body>")) {
    return html.trimEnd() + "\n</html>"; // 只补 </html>
  }

  // 4. 截断 → 续写
  await pushProgress(agent, sessionId, "executing", "HTML 被截断，正在续写...");
  html = await continueHtml(agent, html, sessionId);

  // 5. 最终检查
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================
// LLM 调用
// ============================================================

async function callDesign(agent: Agent, document: any): Promise<any> {
  if (!agent.llm) throw new Error("LLM 未配置");

  const result = await agent.llm.chat_json(
    [
      { role: "system", content: DESIGN_SYSTEM },
      { role: "user", content: DESIGN_USER_TEMPLATE(document) },
    ],
    undefined,
    "code"
  );

  if (result?.error) throw new Error(`design 失败: ${result.error}`);
  if (!result?.project_name) throw new Error("design 返回缺少 project_name");
  return result;
}

async function callGenerateBackend(
  agent: Agent,
  document: any,
  pluginSpec: any,
  projectName: string,
  sessionId: string
): Promise<string> {
  if (!agent.llm) throw new Error("LLM 未配置");

  const raw = await streamLLM(
    agent,
    [
      { role: "system", content: GENERATE_BACKEND_SYSTEM },
      {
        role: "user",
        content: GENERATE_BACKEND_USER_TEMPLATE(document, pluginSpec, projectName),
      },
    ],
    sessionId
  );

  const code = extractPluginBlock(raw, pluginSpec.name);
  if (!code) throw new Error(`无法提取插件代码: ${pluginSpec.name}`);
  return code;
}

async function callGenerateFrontend(
  agent: Agent,
  document: any,
  frontendSpec: any,
  backendSource: string,
  projectName: string,
  apiPlugin: string,
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
          document,
          frontendSpec,
          backendSource,
          projectName,
          apiPlugin
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
  const action = envelop.payload?.action ?? "create";

  let params = envelop.payload?.params ?? {};
  if (Object.keys(params).length === 0) {
    params = { ...envelop.payload };
    delete params.action;
  }

  if (action !== "create") {
    envelop.payload = { ok: false, error: `未知 action: ${action}` };
    return envelop;
  }

  const document = {
    name: params.name ?? "",
    description: params.description ?? "",
  };

  if (!document.name) {
    envelop.payload = { ok: false, error: "缺少 name 参数" };
    return envelop;
  }

  if (!document.description) {
    envelop.payload = { ok: false, error: "缺少 description 参数" };
    return envelop;
  }

  if (!agent.llm) {
    envelop.payload = { ok: false, error: "LLM 未配置" };
    return envelop;
  }

  // ★ sessionId（用于 WS 推送）
  const sessionId = (envelop.meta?.session_id as string) ?? "default";

  // ============================================================
  // 1. design
  // ============================================================

  await pushProgress(agent, sessionId, "executing", "分析需求，设计架构...");

  let design: any;
  try {
    design = await callDesign(agent, document);
  } catch (e: any) {
    envelop.payload = { ok: false, error: `架构设计失败: ${e.message}` };
    return envelop;
  }

  const projectName = design.project_name;
  const pluginsSpec = design.plugins ?? [];
  const hasFrontend = design.has_frontend === true;
  const frontendSpec = design.frontend ?? null;

  const apiPlugin =
    design.frontend?.api_plugin ??
    pluginsSpec[0]?.name?.replace(/\.ts$/, "") ??
    "";

  await pushProgress(
    agent,
    sessionId,
    "done",
    `架构设计完成：${projectName}（${pluginsSpec.length} 个插件${hasFrontend ? "，需要前端" : ""}）`
  );

  // ============================================================
  // 2. 生成后端
  // ============================================================

  const writtenFiles: string[] = [];
  const apiReceivers: string[] = [];
  const backendSources: Array<{ name: string; code: string }> = [];

  let pluginIdx = 0;
  const pluginTotal = pluginsSpec.length;

  for (const pluginSpec of pluginsSpec) {
    pluginIdx++;
    const fileName = pluginSpec.name;
    const finalPath = join(PROJECTS_DIR, projectName, fileName);
    const receiver = `applications/${projectName}/${fileName.replace(/\.ts$/, "")}`;

    await pushProgress(
      agent,
      sessionId,
      "executing",
      `生成 ${fileName}（${pluginIdx}/${pluginTotal}）...`
    );

    // 推分隔头
    await pushCode(
      agent,
      sessionId,
      `\n\n// ══════════════════════════════════════════\n` +
        `// ${fileName}（${pluginIdx}/${pluginTotal}）\n` +
        `// ══════════════════════════════════════════\n\n`
    );

    let code: string;
    try {
      code = await callGenerateBackend(agent, document, pluginSpec, projectName, sessionId);
    } catch (e: any) {
      envelop.payload = {
        ok: false,
        error: `生成后端插件失败 (${fileName}): ${e.message}`,
      };
      return envelop;
    }

    try {
      const actualPath = await atomicWrite(finalPath, code);
      writtenFiles.push(actualPath);
      apiReceivers.push(receiver);
      backendSources.push({ name: fileName, code });
    } catch (e: any) {
      envelop.payload = {
        ok: false,
        error: `写入后端插件失败 (${fileName}): ${e.message}`,
      };
      return envelop;
    }

    await pushProgress(
      agent,
      sessionId,
      "done",
      `${fileName} 写入完成（${code.length} 字）`
    );
  }

  // ============================================================
  // 3. 拼接后端源码（传给前端对齐字段）
  // ============================================================

  let backendSourceContext = "";
  if (backendSources.length > 0) {
    const parts: string[] = [];
    for (const bs of backendSources) {
      parts.push(`=== ${bs.name} ===\n${bs.code}`);
    }
    backendSourceContext = parts.join("\n\n");

    if (backendSourceContext.length > MAX_BACKEND_SOURCE_CHARS) {
      backendSourceContext =
        backendSourceContext.slice(0, MAX_BACKEND_SOURCE_CHARS) +
        "\n\n... (后端源码过长，已截断)";
    }
  }

  // ============================================================
  // 4. 生成前端
  // ============================================================

  if (hasFrontend && frontendSpec) {
    await pushProgress(agent, sessionId, "executing", "生成前端页面...");

    let html: string;
    try {
      html = await callGenerateFrontend(
        agent,
        document,
        frontendSpec,
        backendSourceContext,
        projectName,
        apiPlugin,
        sessionId
      );
    } catch (e: any) {
      envelop.payload = {
        ok: false,
        error: `生成前端失败: ${e.message}`,
        data: {
          project_name: projectName,
          files: writtenFiles,
          receivers: apiReceivers,
        },
      };
      return envelop;
    }

    try {
      const htmlPath = join(WWW_HTML_DIR, projectName, "index.html");
      const actualPath = await atomicWrite(htmlPath, html);
      writtenFiles.push(actualPath);
    } catch (e: any) {
      envelop.payload = {
        ok: false,
        error: `写入 HTML 失败: ${e.message}`,
      };
      return envelop;
    }

    await pushProgress(agent, sessionId, "done", "前端页面生成完成");
  }

  // ============================================================
  // 5. 等 watcher 加载
  // ============================================================

  await pushProgress(agent, sessionId, "executing", "等待热加载编译...");

  await new Promise((r) => setTimeout(r, 3000));

  const receiversToCheck = [...apiReceivers];
  const loadedReceivers = receiversToCheck.filter((r) => plugins.has(r));
  const allLoaded = loadedReceivers.length === receiversToCheck.length;

  // ============================================================
  // 6. 返回
  // ============================================================

  const url = hasFrontend ? `/${projectName}/` : "";
  const baseUrl = (agent as any).base_url ?? "http://127.0.0.1:9000";
  const fullUrl = url ? `${baseUrl}${url}` : "";

  envelop.payload = {
    ok: true,
    data: {
      project_name: projectName,
      type: hasFrontend
        ? apiReceivers.length > 0
          ? "fullstack"
          : "frontend"
        : "backend",
      files: writtenFiles,
      receivers: receiversToCheck,
      loaded: allLoaded,
      url,
      full_url: fullUrl,
    },
    message: allLoaded
      ? `✅ 项目已生成：${projectName}${fullUrl ? `\n访问：${fullUrl}` : ""}`
      : `⚠️ 项目已生成，但部分插件未加载：${projectName}`,
  };
  return envelop;
}

// ============================================================
// help
// ============================================================

export function help() {
  return {
    route: "builtins/tools/create_tool",
    description: "创建新应用（前端 / 后端 / 全栈）",
    input: {
      action: "create（默认）",
      name: "项目名（英文，小写 + 下划线，如 task_board）",
      description: "需求描述（自然语言，越详细越好）",
    },
    output: {
      ok: "是否成功",
      data: {
        project_name: "项目名",
        type: "frontend | backend | fullstack",
        files: "生成的文件列表",
        receivers: "生成的 receiver 列表",
        loaded: "是否全部加载成功",
        url: "前端访问地址",
      },
      message: "结果消息",
    },
  };
}
