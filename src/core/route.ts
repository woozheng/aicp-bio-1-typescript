/**
 * route — 引擎路由
 *
 * 支持三种模式：
 * 1. 同步：无特殊 meta，直接执行插件
 * 2. 本地异步回调：meta.callback_receiver 存在 → 后台执行 + 立即返回 processing
 * 3. 本地回调确认：meta.is_callback 存在 → 立即 ACK + 后台投递
 *
 * 注意：远程通信（跨机器）不在 route 里，由 builtins/tools/remote_agent 处理。
 *
 * 协议级：
 *   - 每次路由尝试消耗一个 ttl
 *   - 结构性失败设置 envelop.status；同时写 payload["error"]（向后兼容）
 */

import { Envelop } from "./Envelop.js";
import type { Agent } from "./Agent.js";
import { plugins } from "./plugins.js";
import {
  STATUS_INVALID,
  STATUS_MISSING,
  STATUS_TIMEOUT,
  STATUS_EXCEPTION,
  STATUS_DORMANT,
} from "./status.js";

// ============================================================
// 异步内部标记（不对外暴露）
// ============================================================

const ASYNC_INTERNAL_KEYS = ["callback_receiver", "_async_started"];

function stripAsyncMeta(meta: Record<string, any>): Record<string, any> {
  const cleaned: Record<string, any> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!ASYNC_INTERNAL_KEYS.includes(k)) cleaned[k] = v;
  }
  return cleaned;
}

// ============================================================
// 主路由
// ============================================================

export async function route(
  envelop: Envelop,
  agent: Agent | null = null,
  timeout: number = 1200
): Promise<Envelop | null> {
  // ---- INVALID：Envelop 结构违反约束 ----
  if (!envelop.receiver) {
    envelop.status = STATUS_INVALID;
    envelop.payload = { ...envelop.payload, error: "Missing receiver" };
    return envelop;
  }

  // ---- DORMANT：ttl 耗尽，终态 ----
  if (envelop.ttl <= 0) {
    envelop.status = STATUS_DORMANT;
    envelop.payload = { ...envelop.payload, error: "TTL expired" };
    return envelop;
  }

  // ---- 每次路由尝试消耗一个 ttl（协议级） ----
  envelop.ttl -= 1;

  // ---- 插件查找（协议级） ----
  const plugin = plugins.get(envelop.receiver);
  if (!plugin) {
    envelop.status = STATUS_MISSING;
    envelop.payload = {
      ...envelop.payload,
      error: `Plugin not found: ${envelop.receiver}`,
    };
    return envelop;
  }

  // ============================================================
  // 模式3：回调确认
  // ============================================================
  if (envelop.meta?.is_callback) {
    deliverCallback(envelop, agent, timeout).catch((e) => {
      console.error(`[route] deliverCallback failed: ${e}`);
    });
    return new Envelop({
      sender: envelop.receiver,
      receiver: envelop.sender,
      payload: { ok: true, received: true },
      meta: { is_ack: true, trace_id: envelop.trace_id },
    });
  }

  // ============================================================
  // 模式2：本地异步回调
  // ============================================================
  const callbackReceiver = envelop.meta?.callback_receiver ?? "";
  if (callbackReceiver) {
    executeAsync(envelop, agent, callbackReceiver, timeout).catch((e) => {
      console.error(`[route] executeAsync failed: ${e}`);
    });
    return new Envelop({
      sender: envelop.receiver,
      receiver: envelop.sender,
      payload: { ok: true, status: "processing" },
      meta: { async: true, trace_id: envelop.trace_id },
    });
  }

  // ============================================================
  // 模式1：同步执行
  // ============================================================
  try {
    const result = await Promise.race([
      plugin(envelop, agent as Agent),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Plugin timeout after ${timeout}s`)),
          timeout * 1000
        )
      ),
    ]);
    return result;
  } catch (e: any) {
    envelop.status = STATUS_EXCEPTION;
    envelop.payload = {
      ...envelop.payload,
      error: `${e?.message ?? String(e)}`.slice(0, 200),
    };
    return envelop;
  }
}

// ============================================================
// 异步执行 + 本地回调
// ============================================================

async function executeAsync(
  envelop: Envelop,
  agent: Agent | null,
  callbackReceiver: string,
  timeout: number
): Promise<void> {
  // 清除异步内部标记
  envelop.meta = stripAsyncMeta(envelop.meta ?? {});

  let result: Envelop;
  try {
    const plugin = plugins.get(envelop.receiver);
    if (plugin) {
      result = (await Promise.race([
        plugin(envelop, agent as Agent),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Plugin timeout after ${timeout}s`)),
            timeout * 1000
          )
        ),
      ])) as Envelop;
    } else {
      result = new Envelop({
        payload: { error: `Plugin not found: ${envelop.receiver}` },
        status: STATUS_MISSING,
      });
    }
  } catch (e: any) {
    result = new Envelop({
      payload: { error: `${e?.message ?? String(e)}`.slice(0, 200) },
      status: STATUS_EXCEPTION,
    });
  }

  if (!result) {
    result = new Envelop({
      payload: { error: "Plugin returned None" },
      status: STATUS_EXCEPTION,
    });
  }
  // 若插件返回了 status=""（成功），保持它。
  // 若插件显式设了 META_FAILED，也保持。

  // 构造回调 Envelop
  result.sender = envelop.receiver;
  result.receiver = callbackReceiver;
  result.trace_id = envelop.trace_id;
  result.meta = result.meta ?? {};
  result.meta.is_callback = true;
  result.meta.callback_original_receiver = envelop.receiver;
  result.meta.trace_id = envelop.trace_id;

  // 透传业务信息
  for (const key of ["remote_node", "remote_plugin", "callback_session_id"]) {
    if (envelop.meta?.[key]) {
      result.meta[key] = envelop.meta[key];
    }
  }

  // session_id 兜底
  if (!result.meta.callback_session_id && envelop.meta?.session_id) {
    result.meta.callback_session_id = envelop.meta.session_id;
  }

  // ============================================================
  // 发送回调（只走内部路由）
  // ============================================================
  if (callbackReceiver.includes("/")) {
    try {
      await route(result, agent, timeout);
    } catch {
      // ignore
    }
  } else {
    // 不是内部 receiver，报错
    console.error(
      `[route] callback_receiver 不是有效的内部 receiver: ${callbackReceiver}`
    );
  }
}

// ============================================================
// 回调投递
// ============================================================

async function deliverCallback(
  envelop: Envelop,
  agent: Agent | null,
  timeout: number
): Promise<void> {
  try {
    const plugin = plugins.get(envelop.receiver);
    if (plugin) {
      await Promise.race([
        plugin(envelop, agent as Agent),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeout * 1000)
        ),
      ]);
    }
  } catch {
    // ignore
  }
}