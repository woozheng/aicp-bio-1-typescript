/**
 * 全局插件地址簿
 * 与 Python 版 core.py 的 plugins 字典完全对应
 *
 * 协议级（Tier 1）：插件按 receiver 在共享命名空间中可达。
 * 具体实现（Map）是 Tier 3 选择；也可以换成文件系统、数据库等。
 */

import type { Envelop } from "./Envelop.js";
import type { Agent } from "./Agent.js";

export type PluginFn = (
  envelop: Envelop,
  agent: Agent
) => Promise<Envelop | null>;

export const plugins: Map<string, PluginFn> = new Map();