/**
 * SystemServer — 系统调用入口
 *
 * 职责：
 * 1. 提供 agent.system.call(envelop) 作为"路由入口"
 * 2. 负责加载和持有 Agent 实例
 * 3. 统一处理插件的调用
 *
 * 这是 Python 版 runtime/_system.py 的 TS 对应。
 */

import { Envelop } from "../core/Envelop.js";
import { Agent } from "../core/Agent.js";
import { route } from "../core/route.js";
import { plugins } from "../core/plugins.js";

export class SystemServer {
  agent: Agent;
  config: Record<string, any>;
  dataDir: string;
  baseUrl: string;

  constructor(options: {
    config?: Record<string, any>;
    dataDir?: string;
    baseUrl?: string;
  } = {}) {
    this.config = options.config ?? {};
    this.dataDir = options.dataDir ?? "data";
    this.baseUrl = options.baseUrl ?? "http://127.0.0.1:9000";

    // 构造 Agent（能力容器）
    this.agent = new Agent({
      config: this.config,
      data_dir: this.dataDir,
      base_url: this.baseUrl,
      log: console,
      system: this,
      llm: null,
    });
  }

  /**
   * 跨插件调用入口 — 等价于 Python 版的 agent.system.call(envelop)
   */
  async call(envelop: Envelop): Promise<Envelop | null> {
    // 注入 session_id 到 meta（如果没传）
    if (!envelop.meta.session_id && this.agent.get("session_id")) {
      envelop.meta.session_id = this.agent.get("session_id");
    }

    // 注入 token（如果没传）
    if (!envelop.meta.token && this.config.tokens?.[0]) {
      envelop.meta.token = this.config.tokens[0];
    }

    return await route(envelop, this.agent);
  }

  /**
   * 注册插件 — 等价于 core.plugins[receiver] = fn
   */
  register(receiver: string, plugin: (...args: any[]) => any): void {
    plugins.set(receiver, plugin);
  }

  /**
   * 注销插件
   */
  unregister(receiver: string): void {
    plugins.delete(receiver);
  }

  /**
   * 列出所有插件
   */
  listPlugins(): string[] {
    return Array.from(plugins.keys());
  }

  /**
   * 设置 LLM 能力
   */
  setLLM(llm: any): void {
    (this.agent as any).llm = llm;
  }
}