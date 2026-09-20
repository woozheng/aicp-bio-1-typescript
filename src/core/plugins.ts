/**
 * 全局插件地址簿
 * 与 Python 版 core.py 的 plugins 字典完全对应
 */

import type { Envelop } from "./Envelop.js";
import type { Agent } from "./Agent.js";

export type PluginFn = (
  envelop: Envelop,
  agent: Agent
) => Promise<Envelop | null>;

export const plugins: Map<string, PluginFn> = new Map();