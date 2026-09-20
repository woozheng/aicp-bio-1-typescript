/**
 * 认证插件 — 协议 v3.0 系统插件
 *
 * 支持 enable_auth 开关，关闭时所有请求放行。
 * 开启时验证 X-AICP-Token / Authorization Bearer / Cookie。
 *
 * 与 Python 版 os/_auth.py 对应。
 */

import { createHmac, createHash, randomBytes } from "node:crypto";
import { readdirSync, existsSync } from "node:fs";
import { Envelop } from "../../core/Envelop.js";
import type { Agent } from "../../core/Agent.js";

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const action = envelop.payload.action ?? "verify";

  if (action === "verify") return await verify(envelop, agent);
  if (action === "login") return await login(envelop, agent);
  if (action === "logout") return await logout(envelop, agent);
  if (action === "generate_app_token") return await generateAppToken(envelop, agent);

  envelop.payload = { error: `Unknown action: ${action}` };
  return envelop;
}

// ============================================================
// verify
// ============================================================

async function verify(envelop: Envelop, agent: Agent): Promise<Envelop> {
  // 来自子目录应用的请求，直接放行
  if (envelop.meta.is_app_request) {
    envelop.payload = { ok: true, message: "App request allowed" };
    return envelop;
  }

  const config = agent.config ?? {};
  const enableAuth = config.enable_auth ?? false;
  if (!enableAuth) {
    envelop.payload = { ok: true, message: "Auth disabled" };
    return envelop;
  }

  const route = envelop.payload.route ?? envelop.receiver;

  // 公开路由
  const publicRoutes = new Set([
    "auth/login",
    "ws_config",
    "health",
  ]);
  if (publicRoutes.has(route)) {
    envelop.payload = { ok: true };
    return envelop;
  }

  // 提取 token
  let token = envelop.meta.token ?? "";
  if (!token) {
    const authHeader = envelop.meta.authorization ?? "";
    if (authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    }
  }
  if (!token) {
    token = envelop.meta.cookie_token ?? "";
  }

  // 验证 token
  const validTokens = new Set<string>(config.tokens ?? []);
  if (token && validTokens.has(token)) {
    envelop.payload = { ok: true };
    return envelop;
  }

  // 验证应用 token
  if (token) {
    const secret = config.app_secret ?? "aicp_default_secret";
    for (const appName of listAppNames()) {
      const expected = generateAppTokenValue(appName, secret);
      if (timingSafeEqual(token, expected)) {
        envelop.meta.app_name = appName;
        envelop.meta.is_app_request = true;
        envelop.payload = { ok: true, app: appName };
        return envelop;
      }
    }
  }

  envelop.payload = { ok: false, error: "Unauthorized" };
  return envelop;
}

// ============================================================
// login / logout
// ============================================================

async function login(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const username = envelop.payload.username ?? "";
  const password = envelop.payload.password ?? "";

  if (!username || !password) {
    envelop.payload = { ok: false, error: "Missing username or password" };
    return envelop;
  }

  const users = agent.config?.users ?? {};
  if (username in users) {
    const stored = users[username];
    if (stored === password || verifyPassword(password, stored)) {
      const secret = agent.config?.token_secret ?? "aicp_session_secret";
      const token = generateSessionToken(username, secret);
      envelop.payload = { ok: true, token, username };
    } else {
      envelop.payload = { ok: false, error: "Invalid credentials" };
    }
  } else {
    envelop.payload = { ok: false, error: "Invalid credentials" };
  }

  return envelop;
}

async function logout(envelop: Envelop, agent: Agent): Promise<Envelop> {
  envelop.payload = { ok: true, message: "Logged out" };
  return envelop;
}

async function generateAppToken(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const appName = envelop.payload.app_name ?? "";
  if (!appName) {
    envelop.payload = { ok: false, error: "Missing app_name" };
    return envelop;
  }

  const secret = agent.config?.app_secret ?? "aicp_default_secret";
  const token = generateAppTokenValue(appName, secret);
  envelop.payload = { ok: true, app_name: appName, token };
  return envelop;
}

// ============================================================
// 工具函数
// ============================================================

function generateAppTokenValue(appName: string, secret: string): string {
  return createHmac("md5", secret).update(appName).digest("hex").slice(0, 16);
}

function generateSessionToken(username: string, secret: string): string {
  const nonce = randomBytes(8).toString("hex");
  const data = `${username}:${nonce}`;
  const signature = createHmac("sha256", secret).update(data).digest("hex").slice(0, 32);
  return `tok_${username}_${signature}`;
}

function verifyPassword(password: string, stored: string): boolean {
  if (stored.startsWith("sha256:")) {
    const expected = stored.slice(7);
    const actual = createHash("sha256").update(password).digest("hex");
    return timingSafeEqual(actual, expected);
  }
  return false;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function listAppNames(): string[] {
  const www = "www";
  if (!existsSync(www)) return [];
  try {
    return readdirSync(www, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}