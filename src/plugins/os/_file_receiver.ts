/**
 * os/_file_receiver — 大文件上传接收
 *
 * 启动一个独立的 HTTP 服务器（port + 2），处理 multipart/form-data 上传。
 * 上传的文件保存到 data/uploads/ 目录。
 *
 * 与 Python 版 os/_file_receiver.py 对应。
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Envelop } from "../../core/Envelop.js";
import type { Agent } from "../../core/Agent.js";

const UPLOAD_DIR = "data/uploads";

let server: any = null;

// ============================================================
// ★ CORS 头
// ============================================================

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-AICP-Token, Authorization",
  };
}

/**
 * 给 Response 加 CORS 头
 */
function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders())) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ============================================================
// 主入口
// ============================================================

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const action = envelop.payload.action ?? "START";  

  if (action === "START") {
    const port = envelop.payload.port ?? 9002;
    const host = envelop.payload.host ?? "127.0.0.1";

    server = Bun.serve({
      port,
      hostname: host,

      async fetch(request: Request): Promise<Response> {
        // ★ OPTIONS 预检
        if (request.method === "OPTIONS") {
          return new Response(null, {
            status: 200,
            headers: corsHeaders(),
          });
        }

        const url = new URL(request.url);

        if (url.pathname === "/upload" && request.method === "POST") {
          return withCors(await handleUpload(request));
        }

        if (url.pathname === "/health") {
          return withCors(Response.json({ status: "ok" }));
        }

        return withCors(new Response("Not found", { status: 404 }));
      },
    });

    agent.log?.info?.(`[FileReceiver] listening on http://${host}:${port}`);

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
// 上传处理
// ============================================================

async function handleUpload(request: Request): Promise<Response> {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return Response.json({ ok: false, error: "No file provided" }, { status: 400 });
    }

    await mkdir(UPLOAD_DIR, { recursive: true });

    // 安全文件名
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const timestamp = Date.now();
    const finalName = `${timestamp}_${safeName}`;
    const filePath = join(UPLOAD_DIR, finalName);

    const buffer = await file.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    return Response.json({
      ok: true,
      file_path: filePath,
      file_name: file.name,
      size: buffer.byteLength,
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

// ============================================================
// help
// ============================================================

export function help() {
  return {
    route: "os/_file_receiver",
    description: "大文件上传接收",
    actions: {
      START: "启动上传服务器",
      STOP: "停止上传服务器",
    },
  };
}