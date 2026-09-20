/**
 * os/_websocket — WebSocket 网关插件
 *
 * 复用 HTTP 路由格式，共享 _auth 认证。
 * 与 Python 版 os/_websocket.py 对应。
 */

import { Envelop } from "../../core/Envelop.js";
import type { Agent } from "../../core/Agent.js";

// ============================================================
// 状态
// ============================================================

// channel_id → Set<ws>
const _channels: Map<string, Set<any>> = new Map();
// ws → Set<channel_id>
const _wsToChannels: Map<any, Set<string>> = new Map();
// ws → ws_id
const _wsId: Map<any, string> = new Map();

let server: any = null;

// ============================================================
// 频道管理
// ============================================================

function register(ws: any, channelId: string): void {
  if (!_channels.has(channelId)) {
    _channels.set(channelId, new Set());
  }
  _channels.get(channelId)!.add(ws);

  if (!_wsToChannels.has(ws)) {
    _wsToChannels.set(ws, new Set());
  }
  _wsToChannels.get(ws)!.add(channelId);

  if (!_wsId.has(ws)) {
    _wsId.set(ws, `ws_${randomHex(6)}`);
  }
}

function unregister(ws: any, channelId?: string): void {
  if (channelId) {
    _channels.get(channelId)?.delete(ws);
    if (_channels.get(channelId)?.size === 0) {
      _channels.delete(channelId);
    }
    _wsToChannels.get(ws)?.delete(channelId);
  } else {
    const channels = _wsToChannels.get(ws) ?? new Set();
    for (const cid of channels) {
      _channels.get(cid)?.delete(ws);
      if (_channels.get(cid)?.size === 0) {
        _channels.delete(cid);
      }
    }
    _wsToChannels.delete(ws);
    _wsId.delete(ws);
  }
}

function push(channelId: string, data: any): number {
  let sent = 0;
  const set = _channels.get(channelId);
  if (!set) return 0;

  for (const ws of set) {
    try {
      ws.send(JSON.stringify(data));
      sent++;
    } catch {
      unregister(ws);
    }
  }
  return sent;
}

function broadcast(data: any): number {
  let sent = 0;
  for (const ws of _wsToChannels.keys()) {
    try {
      ws.send(JSON.stringify(data));
      sent++;
    } catch {
      unregister(ws);
    }
  }
  return sent;
}

function pushToWs(wsId: string, data: any): number {
  let sent = 0;
  for (const [ws, wid] of _wsId) {
    if (wid === wsId) {
      try {
        ws.send(JSON.stringify(data));
        sent++;
      } catch {
        unregister(ws);
      }
    }
  }
  return sent;
}

function getStatus() {
  const channelsInfo: Record<string, any> = {};
  for (const [cid, wsSet] of _channels) {
    channelsInfo[cid] = {
      connections: wsSet.size,
      ws_ids: Array.from(wsSet).map((ws) => _wsId.get(ws) ?? "?"),
    };
  }
  return {
    total_channels: _channels.size,
    total_connections: _wsToChannels.size,
    channels: channelsInfo,
  };
}

function closeChannel(channelId: string): void {
  const set = _channels.get(channelId);
  if (!set) return;
  for (const ws of set) {
    try {
      ws.close(1000, "Channel closed by server");
    } catch {
      // ignore
    }
    unregister(ws, channelId);
  }
}

// ============================================================
// 主入口
// ============================================================

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const action = envelop.payload.action ?? "START";

  if (action === "START") {
    const port = envelop.payload.port ?? 9001;
    const host = envelop.payload.host ?? "127.0.0.1";

    server = Bun.serve({
      port,
      hostname: host,

      fetch(request: Request, server: any): Response | undefined {
        const url = new URL(request.url);

        if (url.pathname === "/ws") {
          const upgraded = server.upgrade(request, {
            data: {
              channelId: url.searchParams.get("channel") ?? `default_${randomHex(6)}`,
              token: url.searchParams.get("token") ?? "",
            },
          });
          if (upgraded) return undefined;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }

        if (url.pathname === "/health") {
          return Response.json({ status: "ok" });
        }

        return new Response("Not found", { status: 404 });
      },

      websocket: {
        open(ws: any) {
          const { channelId, token } = ws.data;

          // 认证（可选）
          const enableAuth = agent.config?.enable_auth ?? false;
          const validTokens = agent.config?.tokens ?? [];
          if (enableAuth && validTokens.length > 0 && !validTokens.includes(token)) {
            ws.close(4001, "Unauthorized");
            return;
          }

          register(ws, channelId);
          const wsId = _wsId.get(ws);

          agent.log?.info?.(`[WS] Connected: ${wsId} → channel=${channelId}`);

          ws.send(JSON.stringify({
            type: "connected",
            ws_id: wsId,
            channel_id: channelId,
            timestamp: Date.now(),
          }));
        },

        async message(ws: any, message: string | Buffer) {
          const text = typeof message === "string" ? message : message.toString();

          let data: any;
          try {
            data = JSON.parse(text);
          } catch {
            ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
            return;
          }

          const type = data.type ?? "";

          if (type === "envelop") {
            const body = data.payload ?? data;
            const env = new Envelop({
              sender: "os/_websocket",
              receiver: data.receiver ?? "",
              intent: body.intent ?? "API_CALL",
              payload: body.payload ?? body,
              meta: {
                ...(body.meta ?? {}),
                ws_id: _wsId.get(ws),
                channel_id: ws.data.channelId,
              },
            });

            const result = await agent.system.call(env);

            ws.send(JSON.stringify({
              type: "envelop_result",
              trace_id: env.meta.trace_id ?? "",
              ok: true,
              payload: result?.payload ?? {},
              timestamp: Date.now(),
            }));
          }

          else if (type === "subscribe") {
            const newChannel = data.channel ?? ws.data.channelId;
            register(ws, newChannel);
            ws.send(JSON.stringify({
              type: "subscribed",
              channel: newChannel,
              timestamp: Date.now(),
            }));
          }

          else if (type === "unsubscribe") {
            const subChannel = data.channel ?? "";
            if (subChannel) {
              unregister(ws, subChannel);
            }
            ws.send(JSON.stringify({
              type: "unsubscribed",
              channel: subChannel,
              timestamp: Date.now(),
            }));
          }

          else if (type === "ping") {
            ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
          }
        },

        close(ws: any) {
          const wsId = _wsId.get(ws);
          unregister(ws);
          agent.log?.info?.(`[WS] Disconnected: ${wsId}`);
        },
      },
    });

    agent.log?.info?.(`[WS] WebSocket server listening on ws://${host}:${port}/ws`);

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

  if (action === "push") {
    const channelId = envelop.payload.channel_id ?? "";
    const data = envelop.payload.data ?? {};
    if (!channelId) {
      envelop.payload = { error: "channel_id required" };
      return envelop;
    }
    data._meta = {
      sender: envelop.sender,
      intent: envelop.intent,
      trace_id: envelop.trace_id,
      timestamp: Date.now() / 1000,
    };
    const sent = push(channelId, data);
    envelop.payload = { ok: true, sent, channel_id: channelId };
    return envelop;
  }

  if (action === "broadcast") {
    const data = envelop.payload.data ?? {};
    data._meta = {
      sender: envelop.sender,
      trace_id: envelop.trace_id,
      timestamp: Date.now() / 1000,
    };
    const sent = broadcast(data);
    envelop.payload = { ok: true, sent };
    return envelop;
  }

  if (action === "push_to_ws") {
    const wsId = envelop.payload.ws_id ?? "";
    const data = envelop.payload.data ?? {};
    if (!wsId) {
      envelop.payload = { error: "ws_id required" };
      return envelop;
    }
    data._meta = {
      sender: envelop.sender,
      trace_id: envelop.trace_id,
      timestamp: Date.now() / 1000,
    };
    const sent = pushToWs(wsId, data);
    envelop.payload = { ok: true, sent, ws_id: wsId };
    return envelop;
  }

  if (action === "status") {
    envelop.payload = getStatus();
    return envelop;
  }

  if (action === "close_channel") {
    const channelId = envelop.payload.channel_id ?? "";
    closeChannel(channelId);
    envelop.payload = { ok: true, channel_id: channelId };
    return envelop;
  }

  envelop.payload = { error: `Unknown action: ${action}` };
  return envelop;
}

// ============================================================
// 工具
// ============================================================

function randomHex(n: number): string {
  const bytes = new Uint8Array(Math.ceil(n / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, n);
}

export function help() {
  return {
    route: "os/_websocket",
    description: "WebSocket 网关 — 实时双向通信",
    actions: {
      START: "启动 WebSocket 服务器",
      STOP: "停止 WebSocket 服务器",
      push: "向频道推送（channel_id, data）",
      broadcast: "广播给所有连接（data）",
      push_to_ws: "推送给指定连接（ws_id, data）",
      status: "查看状态",
      close_channel: "关闭频道（channel_id）",
    },
  };
}
