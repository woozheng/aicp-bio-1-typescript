/**
 * ping — 最小插件，验证 runtime
 */

import type { Envelop } from "../../../core/Envelop.js";
import type { Agent } from "../../../core/Agent.js";

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  envelop.payload = {
    pong: true,
    version: "v300",                    // ← 标记，方便看热重载是否生效
    marker: "HOTRELOAD_TEST_12345",   // ← 更明显的标记
    echo: envelop.payload,
    timestamp: Date.now(),
  };
  return envelop;
}