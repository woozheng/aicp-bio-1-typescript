/**
 * create_tool — 创建新应用（一把梭）
 *
 * 统一 action 模式：action: "create"（默认）
 *
 * 输入：name（英文项目名）+ description（自然语言需求）
 *
 * 流程：
 *   1. design → 架构 JSON
 *   2. 逐个 generate_backend → TS 代码
 *   3. 收集后端源码（传给前端对齐字段）
 *   4. generate_frontend → HTML
 *   5. 生成前端插件 www/{名}.ts（模板化）
 *   6. 原子写所有文件
 *   7. 等 3 秒，查 plugins Map 验证
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
const WWW_PLUGINS_DIR = "src/plugins/www";
const WWW_HTML_DIR = "www";
const MAX_BACKEND_SOURCE_CHARS = 30000;

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

function postProcessHtml(html: string): string {
  html = html.replace(/wss?:\/\/[^"'\s]+\/ws[^"'\s]*/g, "__WS_URL__");
  html = html.replace(/https?:\/\/[^"'\s]+\/upload/g, "__UPLOAD_URL__");
  return html;
}

function extractHtmlBlock(raw: string): string | null {
  const m = raw.match(/=== HTML:\s*[^=]+===\s*\n([\s\S]*?)=== END ===/);
  if (m) return m[1].trim();

  const m2 = raw.match(/(<!DOCTYPE html>[\s\S]*?<\/html>)/i);
  if (m2) return m2[1].trim();

  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeFrontendPlugin(projectName: string): string {
  return `/**
 * www/${projectName} — 前端节点
 *
 * render: 返回 index.html（前台主页）
 * asset:  返回其他页面（admin.html 等）和静态资源（css/js/图片）
 *
 * ⚠️ 关键：asset 对 .html / .htm 也要替换占位符。
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Envelop } from "../../core/Envelop.js";
import type { Agent } from "../../core/Agent.js";

const PROJECT_NAME = "${projectName}";
const WWW_DIR = "www";

function contentTypeOf(ext: string): string {
  switch (ext) {
    case "html":
    case "htm":
      return "text/html; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "js":
      return "application/javascript; charset=utf-8";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "svg":
      return "image/svg+xml";
    case "json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function injectPlaceholders(html: string, agent: Agent): string {
  const wsUrl = agent.config?.websocket?.external_url ?? "ws://127.0.0.1:9001/ws";
  const uploadUrl = agent.config?.upload?.external_url ?? "http://127.0.0.1:9002/upload";
  html = html.replace(/__AICP_PROJECT__/g, PROJECT_NAME);
  html = html.replace(/__WS_URL__/g, wsUrl);
  html = html.replace(/__UPLOAD_URL__/g, uploadUrl);
  return html;
}

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const action = envelop.payload?.action ?? "render";

  if (action === "render") {
    const htmlPath = join(WWW_DIR, PROJECT_NAME, "index.html");
    if (!existsSync(htmlPath)) {
      envelop.payload = { ok: false, error: \`HTML 不存在: \${htmlPath}\` };
      return envelop;
    }
    let html = await readFile(htmlPath, "utf-8");
    html = injectPlaceholders(html, agent);
    if (html.includes("__AICP_PROJECT__") || html.includes("__WS_URL__") || html.includes("__UPLOAD_URL__")) {
      envelop.payload = { ok: false, error: "占位符替换失败" };
      return envelop;
    }
    envelop.payload = { ok: true, content_type: "text/html; charset=utf-8", body: html };
    return envelop;
  }

  if (action === "asset") {
    const assetPath = envelop.payload?.path ?? "";
    const safePath = assetPath.replace(/\\.\\./g, "");
    const fullPath = join(WWW_DIR, PROJECT_NAME, safePath);
    if (!existsSync(fullPath)) {
      envelop.payload = { ok: false, error: \`资源不存在: \${fullPath}\` };
      return envelop;
    }
    const ext = fullPath.split(".").pop()?.toLowerCase() ?? "";
    if (ext === "html" || ext === "htm") {
      let html = await readFile(fullPath, "utf-8");
      html = injectPlaceholders(html, agent);
      envelop.payload = { ok: true, content_type: "text/html; charset=utf-8", body: html };
      return envelop;
    }
    const body = await readFile(fullPath);
    envelop.payload = { ok: true, content_type: contentTypeOf(ext), body };
    return envelop;
  }

  envelop.payload = { ok: false, error: \`未知 action: \${action}\` };
  return envelop;
}

export function help() {
  return {
    route: "www/${projectName}",
    description: "${projectName} 前端节点",
    input: { action: "render | asset", path: "asset 时用" },
    output: { ok: "是否成功", content_type: "MIME", body: "内容" },
  };
}
`;
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
  projectName: string
): Promise<string> {
  if (!agent.llm) throw new Error("LLM 未配置");

  const raw = await agent.llm.chat(
    [
      { role: "system", content: GENERATE_BACKEND_SYSTEM },
      {
        role: "user",
        content: GENERATE_BACKEND_USER_TEMPLATE(document, pluginSpec, projectName),
      },
    ],
    undefined,
    "code"
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
  apiPlugin: string
): Promise<string> {
  if (!agent.llm) throw new Error("LLM 未配置");

  const raw = await agent.llm.chat(
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
    undefined,
    "code"
  );

  const html = extractHtmlBlock(raw);
  if (!html) throw new Error("无法提取 HTML 代码");
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

  // ============================================================
  // 1. design
  // ============================================================

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

  // ============================================================
  // 2. 生成后端
  // ============================================================

  const writtenFiles: string[] = [];
  const apiReceivers: string[] = [];
  const backendSources: Array<{ name: string; code: string }> = [];

  for (const pluginSpec of pluginsSpec) {
    const fileName = pluginSpec.name;
    const finalPath = join(PROJECTS_DIR, projectName, fileName);
    const receiver = `applications/${projectName}/${fileName.replace(/\.ts$/, "")}`;

    let code: string;
    try {
      code = await callGenerateBackend(agent, document, pluginSpec, projectName);
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

    // 超长截断（防止 token 爆）
    if (backendSourceContext.length > MAX_BACKEND_SOURCE_CHARS) {
      backendSourceContext =
        backendSourceContext.slice(0, MAX_BACKEND_SOURCE_CHARS) +
        "\n\n... (后端源码过长，已截断，前端按已展示部分对齐字段)";
    }
  }

  // ============================================================
  // 4. 生成前端
  // ============================================================

  if (hasFrontend && frontendSpec) {
    let html: string;
    try {
      html = await callGenerateFrontend(
        agent,
        document,
        frontendSpec,
        backendSourceContext,
        projectName,
        apiPlugin
      );
      html = postProcessHtml(html);
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

    try {
      const fePluginCode = makeFrontendPlugin(projectName);
      const fePluginPath = join(WWW_PLUGINS_DIR, `${projectName}.ts`);
      const actualPath = await atomicWrite(fePluginPath, fePluginCode);
      writtenFiles.push(actualPath);
    } catch (e: any) {
      envelop.payload = {
        ok: false,
        error: `写入前端插件失败: ${e.message}`,
      };
      return envelop;
    }
  }

  // ============================================================
  // 5. 等 watcher 加载
  // ============================================================

  await new Promise((r) => setTimeout(r, 3000));

  const receiversToCheck = [
    ...apiReceivers,
    ...(hasFrontend ? [`www/${projectName}`] : []),
  ];
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