/**
 * AICP 协议级失败状态（Tier 1）
 *
 * 这些常量由协议定义。插件实现可以读它们，但不应重新定义。
 * 与 Python 版 core.py 的 STATUS_* 常量完全对应。
 *
 * 语义：
 *   空字符串       = 成功（无协议级错误）
 *   INVALID       = Envelop 违反约束（route 产生）
 *   MISSING       = receiver 无对应插件（route 产生）
 *   TIMEOUT       = 路由尝试未在时限内产生结果（route 产生）
 *   EXCEPTION     = 插件抛异常（插件产生）
 *   META_FAILED   = meta 契约无法满足，或拒绝（插件产生）
 *
 * 终止状态（消息不再被尝试）：
 *   DROPPED / ISOLATED / DORMANT
 */

export const STATUS_OK = ""; // 成功：无协议级错误
export const STATUS_INVALID = "INVALID"; // Envelop 违反约束（route 产生）
export const STATUS_MISSING = "MISSING"; // receiver 无对应插件（route 产生）
export const STATUS_TIMEOUT = "TIMEOUT"; // 路由尝试未在时限内产生结果（route 产生）
export const STATUS_EXCEPTION = "EXCEPTION"; // 插件抛异常（插件产生）
export const STATUS_META_FAILED = "META_FAILED"; // meta 契约无法满足，或拒绝（插件产生）

// 终止状态：消息不再被尝试
export const STATUS_DROPPED = "DROPPED"; // 消息被丢弃
export const STATUS_ISOLATED = "ISOLATED"; // 消息被隔离
export const STATUS_DORMANT = "DORMANT"; // ttl 耗尽

const TERMINAL_STATUSES = new Set<string>([
  STATUS_DROPPED,
  STATUS_ISOLATED,
  STATUS_DORMANT,
]);

/**
 * 协议辅助：判断 status 是否为终止状态。
 *
 * 终止状态表示消息不再被尝试；调用者不应再重试。
 * 空字符串（成功）不是终止状态。
 */
export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * 协议辅助：把 Envelop 标记为失败。
 *
 * 设置 status（协议路径），同时写入 payload["error"]（向后兼容）。
 * 插件作者可以选择使用它；不使用也可以直接设置 envelop.status。
 */
export function fail<
  T extends { status: string; payload: Record<string, any> }
>(envelop: T, status: string, message: string = ""): T {
  envelop.status = status;
  if (message) {
    envelop.payload = { ...envelop.payload, error: message };
  }
  return envelop;
}