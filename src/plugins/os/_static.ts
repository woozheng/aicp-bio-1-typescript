/**
 * os/_static — 静态文件服务
 *
 * 与 Python 版 os/_static.py 对应。
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { Envelop } from "../../core/Envelop.js";
import type { Agent } from "../../core/Agent.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const action = envelop.payload.action ?? "serve";
  const filePath = envelop.payload.file_path ?? "";

  if (action === "serve") {
    return await serveFile(envelop, filePath);
  }

  if (action === "serve_data") {
    return await serveFile(envelop, join("data", filePath));
  }

  envelop.payload = { error: `Unknown action: ${action}` };
  return envelop;
}

async function serveFile(envelop: Envelop, filePath: string): Promise<Envelop> {
  // 安全检查：禁止 ..
  const safePath = filePath.replace(/\.\./g, "").replace(/^\/+/, "");

  if (!safePath) {
    envelop.payload = { error: "Empty file path" };
    return envelop;
  }

  // 查找顺序：先 www/，再根目录
  const candidates = [
    join("www", safePath),
    join(".", safePath),
  ];

  for (const candidate of candidates) {
    const fullPath = resolve(candidate);

    // 额外安全检查：确保在项目目录内
    const cwd = resolve(".");
    if (!fullPath.startsWith(cwd)) {
      continue;
    }

    if (existsSync(fullPath)) {
      try {
        const content = await readFile(fullPath);
        const ext = extname(fullPath).toLowerCase();
        const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

        envelop.meta.static_content = content;
        envelop.meta.content_type = contentType;
        envelop.payload = { ok: true };
        return envelop;
      } catch (e: any) {
        envelop.payload = { error: `Read failed: ${e.message}` };
        return envelop;
      }
    }
  }

  envelop.payload = { error: `File not found: ${filePath}` };
  return envelop;
}