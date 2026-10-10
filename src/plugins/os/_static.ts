/**
 * os/_static — 静态文件服务
 *
 * 与 Python 版 os/_static.py / Java 版 os/_static.java 对齐。
 *
 * 三级补全：
 *   1. 精确路径
 *   2. 补 .html
 *   3. {path}/index.html
 *
 * 查找顺序：
 *   1. plugins/{project}/www/{rest}（项目内置前端，可选）
 *   2. www/{path}（全局 www）
 *   3. data/www/{path}
 */

import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { join, extname, resolve, normalize } from "node:path";
import { Envelop } from "../../core/Envelop.js";
import type { Agent } from "../../core/Agent.js";

// ============================================================
// 常量
// ============================================================

const GLOBAL_WWW = "www";
const DATA_WWW = join("data", "www");
const PROJECT_WWW_BASE = "plugins";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".map": "application/json; charset=utf-8",
};

// ============================================================
// 主入口
// ============================================================

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const action = envelop.payload.action ?? "serve";

  switch (action) {
    case "serve":
      return await handleServe(envelop);
    case "serve_data":
      return await handleServeData(envelop);
    case "list":
      return await handleList(envelop);
    default:
      envelop.payload = { ok: false, error: `Unknown action: ${action}` };
      return envelop;
  }
}

// ============================================================
// serve —— 多目录 fallback + 三级补全
// ============================================================

async function handleServe(envelop: Envelop): Promise<Envelop> {
  let filePath = envelop.payload.file_path ?? "";

  // 从 meta 里兜底
  if (!filePath) {
    const metaPath = envelop.meta?.path ?? "";
    filePath = String(metaPath).replace(/^\/+/, "");
  }

  if (!filePath || filePath === "/") {
    filePath = "index.html";
  }

  // 安全检查
  if (!safePath(filePath)) {
    envelop.payload = { ok: false, error: "Forbidden" };
    return envelop;
  }

  // 1. 先查 plugins/{project}/www/{rest}
  const slashIdx = filePath.indexOf("/");
  if (slashIdx > 0) {
    const project = filePath.substring(0, slashIdx);
    const rest = filePath.substring(slashIdx + 1);
    const projectWww = join(PROJECT_WWW_BASE, project, "www");

    if (existsSync(projectWww)) {
      const found = tryFiles(projectWww, rest);
      if (found) {
        return await serveFile(envelop, found, `plugins/${project}/www`);
      }
    }
  }

  // 2. 再查 www/
  const found1 = tryFiles(GLOBAL_WWW, filePath);
  if (found1) {
    return await serveFile(envelop, found1, "www");
  }

  // 3. 再查 data/www/
  const found2 = tryFiles(DATA_WWW, filePath);
  if (found2) {
    return await serveFile(envelop, found2, "data/www");
  }

  envelop.payload = { ok: false, error: `File not found: ${filePath}` };
  return envelop;
}

// ============================================================
// serve_data —— data/ 下的文件
// ============================================================

async function handleServeData(envelop: Envelop): Promise<Envelop> {
  const filePath = envelop.payload.file_path ?? "";
  if (!safePath(filePath)) {
    envelop.payload = { ok: false, error: "Forbidden" };
    return envelop;
  }

  const target = normalizePath("data", filePath);
  if (target && existsSync(target) && statSync(target).isFile()) {
    return await serveFile(envelop, target, "data");
  }

  envelop.payload = { ok: false, error: `File not found: ${filePath}` };
  return envelop;
}

// ============================================================
// list —— 列所有 HTML
// ============================================================

async function handleList(envelop: Envelop): Promise<Envelop> {
  const pages: any[] = [];
  const seen = new Set<string>();

  // 全局 www/
  if (existsSync(GLOBAL_WWW)) {
    await walkHtml(GLOBAL_WWW, GLOBAL_WWW, pages, seen);
  }

  // plugins/{proj}/www/
  if (existsSync(PROJECT_WWW_BASE)) {
    const { readdir } = await import("node:fs/promises");
    try {
      const projectDirs = await readdir(PROJECT_WWW_BASE, { withFileTypes: true });
      for (const d of projectDirs) {
        if (!d.isDirectory()) continue;
        const name = d.name;
        if (name.startsWith("_") || name === "os" || name === "builtins") continue;

        const projectWww = join(PROJECT_WWW_BASE, name, "www");
        if (existsSync(projectWww)) {
          await walkHtml(projectWww, projectWww, pages, seen, name);
        }
      }
    } catch {}
  }

  // 排序
  pages.sort((a, b) => {
    const d = a.path.split("/").length - b.path.split("/").length;
    if (d !== 0) return d;
    return a.path.localeCompare(b.path);
  });

  envelop.payload = { ok: true, pages, total: pages.length };
  return envelop;
}

async function walkHtml(
  dir: string,
  base: string,
  out: any[],
  seen: Set<string>,
  prefix: string = ""
): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkHtml(full, base, out, seen, prefix);
    } else if (entry.name.endsWith(".html")) {
      const rel = full.substring(base.length + 1).replace(/\\/g, "/");
      const path = prefix ? `${prefix}/${rel}` : rel;
      const url = "/" + path;
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({
        path,
        url,
        size: statSync(full).size,
      });
    }
  }
}

// ============================================================
// 三级补全
// ============================================================

function tryFiles(baseDir: string, filePath: string): string | null {
  // 1. 精确
  let target = normalizePath(baseDir, filePath);
  if (target && existsSync(target) && statSync(target).isFile()) {
    return target;
  }

  // 2. 补 .html
  target = normalizePath(baseDir, filePath + ".html");
  if (target && existsSync(target) && statSync(target).isFile()) {
    return target;
  }

  // 3. {path}/index.html
  target = normalizePath(baseDir, filePath + "/index.html");
  if (target && existsSync(target) && statSync(target).isFile()) {
    return target;
  }

  return null;
}

// ============================================================
// 路径安全
// ============================================================

function safePath(p: string): boolean {
  if (!p) return true;
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  if (p.includes("..")) return false;
  if (p.length >= 2 && p[1] === ":") return false;
  return true;
}

function normalizePath(baseDir: string, filePath: string): string | null {
  try {
    const base = resolve(baseDir);
    const full = resolve(base, filePath);
    if (!full.startsWith(base)) return null;
    return full;
  } catch {
    return null;
  }
}

// ============================================================
// 读文件 + 组装响应
// ============================================================

async function serveFile(
  envelop: Envelop,
  fullPath: string,
  sourceDir: string
): Promise<Envelop> {
  try {
    const content = await readFile(fullPath);
    const ext = extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

    // ★ 关键：用 Buffer 传给 meta.static_content
    // _gateway 里 `new Response(result.meta.static_content)` 能直接吃 Buffer
    envelop.meta.static_content = content;
    envelop.meta.content_type = contentType;
    envelop.meta.file_size = content.length;
    envelop.meta.source_dir = sourceDir;

    envelop.payload = {
      ok: true,
      found: true,
      source: fullPath.replace(/\\/g, "/"),
      size: content.length,
    };
    return envelop;
  } catch (e: any) {
    envelop.payload = { ok: false, error: `Read failed: ${e.message}` };
    return envelop;
  }
}
