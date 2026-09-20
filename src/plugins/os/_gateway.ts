/**
 * HTTP 入口插件 — 纯网关，只做协议转换和路由转发
 *
 * 与 Python 版 os/_gateway.py 对应。
 *
 * 路由约定：
 * - POST /api/{receiver}  → 调后端插件
 * - GET  /{项目名}/        → 调 www/{项目名}::render
 * - GET  /{项目名}/{路径}  → 调 www/{项目名}::asset
 * - GET  /{其他}           → 回退 os/_static
 */

import { Envelop } from "../../core/Envelop.js";
import { plugins } from "../../core/plugins.js";
import type { Agent } from "../../core/Agent.js";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

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
        await scan(full, rel);
      } else if (entry.name === "index.html") {
        // ★ 目录名（去掉 `_` 前缀）
        const dirName = rel.replace(/\/index\.html$/, "");
        const urlName = dirName.startsWith("_") ? dirName.slice(1) : dirName;
        pages.push({
          path: rel,
          url: `/${urlName}/`,
          name: urlName,                        // ★ 名字 = 目录名
          is_system: dirName.startsWith("_"),   // ★ 系统页面标识
        });
      }
    }
  }

  await scan(WWW_DIR);
  return jsonResponse({ pages });
}
let server: any = null;

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const action = envelop.payload.action ?? "START";

  if (action === "START") {
    const port = envelop.payload.port ?? 9000;
    const host = envelop.payload.host ?? "127.0.0.1";

    server = Bun.serve({
      port,
      hostname: host,

      async fetch(request: Request): Promise<Response> {
        return await handleRequest(request, agent);
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
// 请求处理
// ============================================================

async function handleRequest(request: Request, agent: Agent): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders(),
    });
  }

   if (request.method === "GET" && path === "/api/pages") {
    return await handlePages();
  }
    // ★ POST /api/auth/verify
  if (request.method === "POST" && path === "/api/auth/verify") {
    const token = request.headers.get("X-AICP-Token") ?? "";
    const validTokens = (agent as any).config?.tokens ?? [];
    const enableAuth = (agent as any).config?.enable_auth ?? false;

    let ok = false;
    if (!enableAuth || validTokens.length === 0) {
      ok = true;
    } else if (token && validTokens.includes(token)) {
      ok = true;
    }

    return jsonResponse({ ok });
  }
  // POST /api/{path}
  if (request.method === "POST" && path.startsWith("/api/")) {
    return await handleApi(request, path.slice(5), agent);
  }

  // GET /{path}
  if (request.method === "GET") {
    return await handleStatic(request, path.slice(1), agent);
  }

  return jsonResponse({ error: "Method not allowed" }, 405);
}

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
      token: request.headers.get("X-AICP-Token") ?? "",
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
// 静态/前端路由
// ============================================================

async function handleStatic(
  request: Request,
  filePath: string,
  agent: Agent
): Promise<Response> {
  // ★ 门禁：/ 或空路径 → 检查 token → 跳 /login/ 或 /console/
  if (!filePath || filePath === "/" || filePath === "index.html") {
    const token = request.headers.get("X-AICP-Token") ?? "";
    const cookieMatch = request.headers.get("cookie")?.match(/aicp_token=([^;]+)/);
    const cookieToken = cookieMatch ? cookieMatch[1] : "";
    const hasToken = token || cookieToken;

    const enableAuth = (agent as any).config?.enable_auth ?? false;
    const validTokens = (agent as any).config?.tokens ?? [];

    let valid = false;
    if (!enableAuth || validTokens.length === 0) {
      valid = true;
    } else if (hasToken && validTokens.includes(hasToken)) {
      valid = true;
    }

    return Response.redirect(valid ? "/console/" : "/login/", 302);
  }

  // ★ 解析第一段作为「项目名」
  const parts = filePath.split("/").filter(Boolean);
  const projectName = parts[0] ?? "";
  const rest = parts.slice(1).join("/");

  if (projectName) {
    // ★ 先试 www/{项目名}（用户项目）
    let frontendReceiver = `www/${projectName}`;
    // ★ 没有则试 www/_{项目名}（系统页面）
    if (!plugins.has(frontendReceiver)) {
      const sysReceiver = `www/_${projectName}`;
      if (plugins.has(sysReceiver)) {
        frontendReceiver = sysReceiver;
      }
    }

     if (plugins.has(frontendReceiver)) {
      // ★ 系统页面（www/_xxx，除了 www/_login）要检查 token
      if (frontendReceiver.startsWith("www/_") && frontendReceiver !== "www/_login") {
        const token = request.headers.get("X-AICP-Token") ?? "";
        const cookieMatch = request.headers.get("cookie")?.match(/aicp_token=([^;]+)/);
        const cookieToken = cookieMatch ? cookieMatch[1] : "";
        const hasToken = token || cookieToken;

        const enableAuth = (agent as any).config?.enable_auth ?? false;
        const validTokens = (agent as any).config?.tokens ?? [];

        let valid = false;
        if (!enableAuth || validTokens.length === 0) {
          valid = true;
        } else if (hasToken && validTokens.includes(hasToken)) {
          valid = true;
        }

        if (!valid) {
          return Response.redirect("/login/", 302);
        }
      }

      const isIndex = !rest || rest === "index.html" || rest.endsWith("/index.html");
      const action = isIndex ? "render" : "asset";

      const env = new Envelop({
        sender: "os/_gateway",
        receiver: frontendReceiver,
        intent: "API_CALL",
        payload: {
          action,
          path: rest,
        },
        meta: {
          token: request.headers.get("X-AICP-Token") ?? "",
          method: "GET",
          path: filePath,
        },
      });
      const result = await agent.system.call(env);

      if (!result) {
        return jsonResponse({ error: "no response" }, 500);
      }

      // 前端插件失败
      if (result.payload?.ok === false) {
        return new Response(result.payload.error ?? "not found", {
          status: 404,
          headers: corsHeaders(),
        });
      }

      // 前端插件成功
      return new Response(result.payload.body, {
        headers: {
          "Content-Type": result.payload.content_type ?? "text/html; charset=utf-8",
          ...corsHeaders(),
        },
      });
    }
  }

  // ★ 回退 os/_static（现有行为）
  const env = new Envelop({
    sender: "os/_gateway",
    receiver: "os/_static",
    intent: "API_CALL",
    payload: {
      action: "serve",
      file_path: filePath,
    },
    meta: {
      token: request.headers.get("X-AICP-Token") ?? "",
      method: "GET",
      path: filePath,
    },
  });

  const result = await agent.system.call(env);

  if (!result) {
    return jsonResponse({ error: "no response" }, 500);
  }

  if (result.meta?.static_content) {
    return new Response(result.meta.static_content, {
      headers: {
        "Content-Type": result.meta.content_type ?? "text/html",
        ...corsHeaders(),
      },
    });
  }

  if (result.payload?.error) {
    return new Response(result.payload.error, { status: 404 });
  }

  return jsonResponse(result.payload ?? { ok: true });
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