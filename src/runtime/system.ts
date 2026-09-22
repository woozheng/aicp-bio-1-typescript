/**
 * SystemServer — 系统调用入口
 *
 * 职责：
 * 1. 提供 agent.system.call(envelop) 作为"路由入口"
 * 2. 负责加载和持有 Agent 实例
 * 3. 统一处理插件的调用
 * 4. 可视化旁路：call 前后塞事件到队列，异步推 WebSocket
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

  // ---------- 可视化配置 ----------
  private _vizEnabled: boolean = false;
  private _vizChannel: string = "pa_visualizer";
  private _vizQueue: Array<{ direction: string; envelop: Envelop; response?: Envelop | null }> = [];
  private _vizRunning: boolean = false;
  private _vizQueueMax: number = 1000;

  constructor(options: {
    config?: Record<string, any>;
    dataDir?: string;
    baseUrl?: string;
  } = {}) {
    this.config = options.config ?? {};
    this.dataDir = options.dataDir ?? "data";
    this.baseUrl = options.baseUrl ?? "http://127.0.0.1:9000";

    // ---------- 读可视化配置 ----------
    const viz = this.config.visualization;
    let queueSize = 1000;
    if (viz && typeof viz === "object") {
      this._vizEnabled = viz.enabled === true;
      this._vizChannel = viz.channel ?? "pa_visualizer";
      queueSize = viz.queue_size ?? 1000;
    } else if (viz === true) {
      this._vizEnabled = true;
    }
    this._vizQueueMax = queueSize;

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

    // ---------- 可视化推送（out）----------
    if (this._vizEnabled) {
      this._vizPush({ direction: "out", envelop });
    }

    const response = await route(envelop, this.agent);

    // ---------- 可视化推送（in）----------
    if (this._vizEnabled) {
      this._vizPush({ direction: "in", envelop, response });
    }

    return response;
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

  // ============================================================
  // 可视化
  // ============================================================

  /**
   * 启动可视化 worker（如果开启）
   */
  async startVisualizer(): Promise<void> {
    if (!this._vizEnabled || this._vizRunning) return;
    this._vizRunning = true;
    this._vizLoop();
  }

  private _vizPush(item: { direction: string; envelop: Envelop; response?: Envelop | null }): void {
    if (this._vizQueue.length >= this._vizQueueMax) {
      // 队列满，丢弃（不影响主流程）
      return;
    }
    this._vizQueue.push(item);
  }

  private async _vizLoop(): Promise<void> {
    while (this._vizRunning) {
      if (this._vizQueue.length === 0) {
        await new Promise((r) => setTimeout(r, 10));
        continue;
      }

      const item = this._vizQueue.shift()!;
      try {
        await this._vizPushEvent(item);
      } catch (e) {
        // 推送失败不影响主流程
      }
    }
  }

  private async _vizPushEvent(item: {
    direction: string;
    envelop: Envelop;
    response?: Envelop | null;
  }): Promise<void> {
    // 直接走 route，避免走 system.call 造成递归
    const vizEnvelop = new Envelop({
      sender: "os/_visualizer",
      receiver: "os/_websocket",
      payload: {
        action: "push",
        channel_id: this._vizChannel,
        data: {
          type: "envelop",
          direction: item.direction,
          sender: item.envelop.sender,
          receiver: item.envelop.receiver,
          intent: item.envelop.intent,
          trace_id: item.envelop.trace_id,
          timestamp: Date.now() / 1000,
          has_response: item.response != null,
        },
      },
    });

    try {
      await route(vizEnvelop, this.agent);
    } catch (e) {
      // ignore
    }
  }
}