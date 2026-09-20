/**
 * www/skill_loader — 技能加载器前端节点
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Envelop } from "../../core/Envelop.js";
import type { Agent } from "../../core/Agent.js";

const PROJECT_NAME = "_skill_loader";
const WWW_DIR = "www";

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const action = envelop.payload?.action ?? "render";

  if (action === "render") {
    const htmlPath = join(WWW_DIR, PROJECT_NAME, "index.html");
    if (!existsSync(htmlPath)) {
      envelop.payload = { ok: false, error: `HTML 不存在: ${htmlPath}` };
      return envelop;
    }

    let html = await readFile(htmlPath, "utf-8");

    const wsUrl = agent.config?.websocket?.external_url ?? "ws://127.0.0.1:9001/ws";
    const uploadUrl = agent.config?.upload?.external_url ?? "http://127.0.0.1:9002/upload";

    html = html.replace(/__AICP_PROJECT__/g, PROJECT_NAME);
    html = html.replace(/__WS_URL__/g, wsUrl);
    html = html.replace(/__UPLOAD_URL__/g, uploadUrl);

    envelop.payload = {
      ok: true,
      content_type: "text/html; charset=utf-8",
      body: html,
    };
    return envelop;
  }

  if (action === "asset") {
    const assetPath = envelop.payload?.path ?? "";
    const safePath = assetPath.replace(/\.\./g, "");
    const fullPath = join(WWW_DIR, PROJECT_NAME, safePath);

    if (!existsSync(fullPath)) {
      envelop.payload = { ok: false, error: `资源不存在: ${fullPath}` };
      return envelop;
    }

    const body = await readFile(fullPath);
    const ext = fullPath.split(".").pop()?.toLowerCase();
    const contentType =
      ext === "css" ? "text/css" :
      ext === "js"  ? "application/javascript" :
      ext === "png" ? "image/png" :
      ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
      ext === "svg" ? "image/svg+xml" :
      "application/octet-stream";

    envelop.payload = { ok: true, content_type: contentType, body };
    return envelop;
  }

  envelop.payload = { ok: false, error: `未知 action: ${action}` };
  return envelop;
}

export function help() {
  return {
    route: "www/skill_loader",
    description: "skill_loader 前端节点",
    input: { action: "render | asset", path: "asset 时用" },
    output: { ok: "是否成功", content_type: "MIME", body: "内容" },
  };
}