/**
 * AICP Core — 统一导出
 */

export { Envelop } from "./Envelop.js";
export { Agent } from "./Agent.js";
export { plugins, type PluginFn } from "./plugins.js";
export { route } from "./route.js";

// 协议级失败状态（Tier 1）
export {
  STATUS_OK,
  STATUS_INVALID,
  STATUS_MISSING,
  STATUS_TIMEOUT,
  STATUS_EXCEPTION,
  STATUS_META_FAILED,
  STATUS_DROPPED,
  STATUS_ISOLATED,
  STATUS_DORMANT,
  isTerminal,
  fail,
} from "./status.js";