/**
 * HTTP 入口插件 — 纯网关，只做协议转换和路由转发
 *
 * 与 Python 版 os/_gateway.py / Java 版 os/_gateway.java 对齐。
 *
 * 路由：
 *   GET  /                → www/index.html（需鉴权）
 *   GET  /login.html      → 公开（登录页）
 *   GET  /api/pages       → 扫 www/ 列页面（需鉴权）
 *   GET  /api/ws_config   → WebSocket 地址（公开）
 *   GET  /api/backend_info→ 后端信息（公开）
 *   GET  /api/{receiver}  → 转发给插件（需鉴权）
 *   GET  /{path}          → 委托 os/_static serve（需鉴权）
 *   POST /api/auth/verify → 验证 token（公开）
 *   POST /api/{receiver}  → 认证 + 转发（需鉴权）
 *
 * 鉴权策略：
 *   - enable_auth=false 或 tokens=[]  → 全部放行
 *   - enable_auth=true              → 检查 token（X-AICP-Token / Cookie / Bearer）
 *   - 公开路径（login.html / auth/verify / backend_info / ws_config / health） → 放行
 *   - 静态资源（css/js/图片/字体） → 放行
 *   - 其他：
 *       API 未授权  → 401
 *       页面未授权  → 302 跳 /login.html?redirect=xxx
 */

import { Envelop } from "../../core/Envelop.js";
import type { Agent } from "../../core/Agent.js";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

let server: any = null;

// ============================================================
// 常量
// ============================================================

// 公开路径（不需要 token）
const PUBLIC_PATHS = new Set([
  "/login.html",
  "/login",
  "/404.html",
  "/api/auth/verify",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/backend_info",
  "/api/ws_config",
 "/api/upload_config",   // ★ 新增
  "/health",
]);

// 静态资源扩展名（css/js/图片/字体，免鉴权）
const STATIC_EXTS = [
  ".css", ".js", ".mjs", ".map",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp",
  ".woff", ".woff2", ".ttf", ".otf",
];

// ============================================================
// 生命周期
// ============================================================

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const action = envelop.payload.action ?? "START";

  if (action === "START") {
    const port = envelop.payload.port ?? 9000;
    const host = envelop.payload.host ?? "127.0.0.1";

    server = Bun.serve({
      port,
      hostname: host,
      async fetch(request: Request): Promise<Response> {
        try {
          return await handleRequest(request, agent);
        } catch (e: any) {
          (agent as any).log?.error?.(`[Gateway] request error: ${e.message}`);
          return jsonResponse({ error: `server error: ${e.message}` }, 500);
        }
      },
    });

    (agent as any).log.info(`[Gateway] HTTP server listening on http://${host}:${port}`);

    envelop.payload = { status: "listening", port, host };
    return envelop;
  }

  if (action === "STOP") {
    if (server) {
      server.stop();
      server = null;
    }
    envelop.payload = { status: "stopped" };
    return envelop;
  }

  envelop.payload = { error: `Unknown action: ${action}` };
  return envelop;
}

// ============================================================
// 请求分发
// ============================================================

async function handleRequest(request: Request, agent: Agent): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS 预检
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders() });
  }

  // ============================================================
  // 服务端鉴权（核心）
  // ============================================================

  const enableAuth = (agent as any).config?.enable_auth === true;
  const validTokens: string[] = (agent as any).config?.tokens ?? [];
  const authActive = enableAuth && validTokens.length > 0;

  const isPublicPath = PUBLIC_PATHS.has(path);
  const isStaticExt = STATIC_EXTS.some(ext => path.toLowerCase().endsWith(ext));

  // ★ 没有 isLocal / isSameOrigin 后门 —— 本地也拦
  const needAuth = authActive && !isPublicPath && !isStaticExt;

  // 调试日志（可选，上线可注释）
  // console.log("[Gateway]", {
  //   path, method: request.method,
  //   authActive, isPublicPath, isStaticExt, needAuth,
  // });

  if (needAuth) {
    const token = extractToken(request);
    const ok = token && validTokens.includes(token);

    if (!ok) {
      // API 请求 → 401
      if (path.startsWith("/api/")) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }

      // 页面请求 → 302 跳 login
      // 判断是否是"页面"：/ 或 .html 或无扩展名
      const isPageRequest =
        path === "/" ||
        path.endsWith(".html") ||
        !path.includes(".");

      if (isPageRequest) {
        const redirect = encodeURIComponent(path + url.search);
        return new Response(null, {
          status: 302,
          headers: {
            Location: `/login.html?redirect=${redirect}`,
            ...corsHeaders(),
          },
        });
      }

      // 其他（如图片）→ 401
      return new Response("Unauthorized", { status: 401, headers: corsHeaders() });
    }
  }

  // ============================================================
  // 内置 GET 端点（鉴权已过）
  // ============================================================

  // GET /api/pages
  if (request.method === "GET" && path === "/api/pages") {
    return await handlePages();
  }
  if (request.method === "GET" && path === "/api/upload_config") {
      const uploadConfig = (agent as any).config?.upload ?? {};
      const uploadExternalUrl = uploadConfig.external_url ?? "";
      const port = (agent as any).config?.port ?? 9000;
      const uploadPort = port + 2;

      const url = new URL(request.url);
      const hostname = url.hostname;
      const isSecure = request.headers.get("X-Forwarded-Proto") === "https";
      const protocol = isSecure ? "https" : "http";

      const uploadUrl = uploadExternalUrl || `${protocol}://${hostname}:${uploadPort}/upload`;

      return jsonResponse({
          url: uploadUrl,
          port: uploadPort,
          secure: isSecure,
      });
  }
  // GET /api/ws_config
  if (request.method === "GET" && path === "/api/ws_config") {
    return await handleWsConfig(request, agent);
  }

  // GET /api/backend_info
  if (request.method === "GET" && path === "/api/backend_info") {
    return await handleBackendInfo(agent);
  }

  // ============================================================
  // POST /api/auth/verify（公开，不走鉴权）
  // ============================================================
  if (request.method === "POST" && path === "/api/auth/verify") {
    const token = extractToken(request);

    let ok = false;
    if (!authActive) {
      ok = true;
    } else if (token && validTokens.includes(token)) {
      ok = true;
    }

    return jsonResponse({ ok });
  }

  // ============================================================
  // POST /api/{path}
  // ============================================================
  if (request.method === "POST" && path.startsWith("/api/")) {
    return await handleApi(request, path.slice(5), agent);
  }

  // ============================================================
  // GET /{path} —— 静态文件
  // ============================================================
  if (request.method === "GET") {
    return await handleStatic(request, path.slice(1), agent);
  }

  return jsonResponse({ error: "Method not allowed" }, 405);
}

// ============================================================
// GET /api/pages
// ============================================================

async function handlePages(): Promise<Response> {
  const pages: any[] = [];
  const WWW_DIR = "www";

  async function scan(dir: string, prefix: string = ""): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);

      if (entry.isDirectory()) {
        // 递归子目录
        await scan(full, rel);
      }
      else if (entry.name === "index.html") {
        // ★ 子目录的 index.html → 项目页面
        const dirName = rel.replace(/\/index\.html$/, "");
        const urlName = dirName.startsWith("_") ? dirName.slice(1) : dirName;
        pages.push({
          path: rel,
          url: `/${urlName}/`,
          name: urlName,
          is_system: dirName.startsWith("_"),
        });
      }
      else if (entry.name.endsWith(".html") && !prefix) {
        // ★ 根目录的 .html → 系统页面
        const name = entry.name.replace(/\.html$/, "");
        pages.push({
          path: rel,
          url: `/${rel}`,           // 例：/console.html
          name: name,               // 例：console
          is_system: false,
        });
      }
    }
  }

  await scan(WWW_DIR);
  return jsonResponse({ pages });
}
// ============================================================
// GET /api/ws_config
// ============================================================

async function handleWsConfig(request: Request, agent: Agent): Promise<Response> {
  const wsConfig = (agent as any).config?.websocket ?? {};
  const wsExternalUrl = wsConfig.external_url ?? "";
  const port = (agent as any).config?.port ?? 9000;
  const wsPort = port + 1;

  const url = new URL(request.url);
  const hostname = url.hostname;
  const isSecure = request.headers.get("X-Forwarded-Proto") === "https";
  const protocol = isSecure ? "wss" : "ws";

  const wsUrl = wsExternalUrl || `${protocol}://${hostname}:${wsPort}/ws`;

  return jsonResponse({
    url: wsUrl,
    port: wsPort,
    secure: isSecure,
  });
}

// ============================================================
// GET /api/backend_info
// ============================================================

async function handleBackendInfo(agent: Agent): Promise<Response> {
  const features = [
    "plugin", "frontend", "studio",
    "websocket", "file_receiver",
    "restart", "cron",
  ];

  const enableAuth = (agent as any).config?.enable_auth === true;
  const validTokens: string[] = (agent as any).config?.tokens ?? [];

  if (enableAuth && validTokens.length > 0) {
    features.push("auth_required");
  }

  return jsonResponse({
    language: "typescript",
    runtime: process.version,
    version: "5.3",
    protocol_version: "5.4",
    plugins_dir: "plugins",
    www_dir: "www",
    features,
  });
}

// ============================================================
// POST /api/{path}
// ============================================================

async function handleApi(
  request: Request,
  route: string,
  agent: Agent
): Promise<Response> {
  let body: Record<string, any> = {};
  let rawBody = "";

  try {
    rawBody = await request.text();
    if (rawBody) {
      body = JSON.parse(rawBody);
    }
  } catch {
    body = {};
  }

  if (typeof body !== "object" || body === null) {
    body = { data: body };
  }

  const bodyMeta = typeof body.meta === "object" && body.meta !== null ? body.meta : {};
  const bodyPayload = typeof body.payload === "object" && body.payload !== null ? body.payload : body;

  const env = new Envelop({
    sender: "os/_gateway",
    receiver: route,
    intent: typeof body.intent === "string" ? body.intent : "API_CALL",
    payload: bodyPayload,
    meta: {
      ...bodyMeta,
      token: extractToken(request),
      method: request.method,
      path: route,
      raw_body: rawBody,
    },
  });

  const result = await agent.system.call(env);

  if (!result) {
    return jsonResponse({ error: "no response" }, 500);
  }

  if (result.meta?.static_content) {
    return new Response(result.meta.static_content, {
      headers: {
        "Content-Type": result.meta.content_type ?? "application/octet-stream",
        ...corsHeaders(),
      },
    });
  }

  return jsonResponse(result.payload ?? { ok: true });
}

// ============================================================
// GET /{path}
// ============================================================

async function handleStatic(
  request: Request,
  filePath: string,
  agent: Agent
): Promise<Response> {
  // 根路径 → index.html
  if (!filePath || filePath === "/") {
    filePath = "index.html";
  }

  const env = new Envelop({
    sender: "os/_gateway",
    receiver: "os/_static",
    intent: "API_CALL",
    payload: {
      action: "serve",
      file_path: filePath,
    },
    meta: {
      token: extractToken(request),
      method: "GET",
      path: filePath,
    },
  });

  const result = await agent.system.call(env);

  if (!result) {
    return jsonResponse({ error: "no response" }, 500);
  }

  // 静态内容
  if (result.meta?.static_content) {
    return new Response(result.meta.static_content, {
      headers: {
        "Content-Type": result.meta.content_type ?? "text/html; charset=utf-8",
        ...corsHeaders(),
      },
    });
  }

  // 二进制文件
  if (result.meta?.response_type === "file") {
    const fp = result.meta.file_path;
    if (!fp) {
      return jsonResponse({ error: "File not found" }, 404);
    }
    const file = Bun.file(fp);
    return new Response(file, {
      headers: {
        "Content-Type": result.meta.content_type ?? "application/octet-stream",
        "Content-Disposition": `${result.meta.content_disposition ?? "inline"}; filename="${result.meta.file_name ?? "file"}"`,
        ...corsHeaders(),
      },
    });
  }

  // 错误
  if (result.payload?.error) {
    const errStr = String(result.payload.error);
    const status = errStr.includes("Forbidden") ? 403 : 404;
    return new Response(errStr, { status, headers: corsHeaders() });
  }

  return jsonResponse(result.payload ?? { ok: true });
}

// ============================================================
// 鉴权工具
// ============================================================

/** 提取 token：X-AICP-Token → Authorization Bearer → Cookie */
function extractToken(request: Request): string {
  // 1. X-AICP-Token
  let token = request.headers.get("X-AICP-Token") ?? "";
  if (token) return token;

  // 2. Authorization: Bearer xxx
  const authHeader = request.headers.get("Authorization") ?? "";
  if (authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7);
    if (token) return token;
  }

  // 3. Cookie: aicp_token=xxx
  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = cookieHeader.match(/aicp_token=([^;]+)/);
  if (match) return match[1];

  return "";
}

// ============================================================
// 工具函数
// ============================================================

function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-AICP-Token, Authorization",
  };
}
