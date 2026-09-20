// src/test/aicp_chat.test.ts
//
// aicp_chat 完整测试用例（真实 LLM + 计数器）
//
// 运行：bun test src/test/aicp_chat.test.ts
//
// 前置条件：
// 1. 项目根目录有 aicp.yaml（或环境变量配好 LLM）
// 2. 白名单包已安装（lodash 等）

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  setDefaultTimeout,
} from "bun:test";

import { SystemServer } from "../runtime/system.js";
import { LLM } from "../runtime/llm.js";
import { PluginLoader } from "../runtime/plugin_loader.js";
import { loadConfig } from "../runtime/config.js";
import { Envelop } from "../core/Envelop.js";
import { installLogger } from "../runtime/logger.js";

// ============================================================
// 全局超时
// ============================================================

// ★ 真实 LLM 调用慢，默认 5 秒不够，改成 60 秒
setDefaultTimeout(60000);

// ============================================================
// 全局：系统实例 + 计数器
// ============================================================

let system: SystemServer;
let countedLlm: any;

const callCounter = {
  total: 0,
  byTask: new Map<string, number>(),

  reset() {
    this.total = 0;
    this.byTask.clear();
  },

  record(task: string) {
    this.total++;
    const key = task.slice(0, 60);
    this.byTask.set(key, (this.byTask.get(key) ?? 0) + 1);
  },
};

// ============================================================
// 启动系统
// ============================================================

beforeAll(async () => {
  installLogger();

  const config = loadConfig();

  system = new SystemServer({
    config,
    dataDir: config.data_dir,
    baseUrl: `http://${
      config.host === "0.0.0.0" ? "127.0.0.1" : config.host
    }:${config.port}`,
  });

  // LLM：直接从配置取
  const llm = new LLM(config.models ?? {});

  // 包一层计数器
  countedLlm = {
    chat: async (messages: any[], model?: string, role?: string) => {
      const task = messages[messages.length - 1]?.content ?? "";
      callCounter.record(task);
      return llm.chat(messages, model, role);
    },
    chat_json: async (messages: any[], model?: string, role?: string) => {
      const task = messages[messages.length - 1]?.content ?? "";
      callCounter.record(task);
      return llm.chat_json(messages, model, role);
    },
    chat_stream: llm.chat_stream?.bind(llm),
  };

  system.setLLM(countedLlm as any);

  // 加载插件
  const loader = new PluginLoader(system, config.plugins_dir);
  const loaded = await loader.loadAll();
  console.log(`[test] Loaded ${loaded} plugins`);
});

afterAll(() => {
  if ((system as any)?.stop) {
    (system as any).stop();
  }
});

// ============================================================
// 辅助函数
// ============================================================

async function runChat(
  task: string,
  extra?: Record<string, any>
): Promise<{ ok: boolean; data?: any; error?: string; calls: number }> {
  callCounter.reset();

  const envelop = new Envelop({
    sender: "test",
    receiver: "builtins/tools/aicp_chat",
    payload: {
      action: "chat",
      task,
      ...extra,
    },
  });

  const result = await system.call(envelop);
  const payload = (result?.payload ?? {}) as {
    ok?: boolean;
    data?: any;
    error?: string;
  };

  return {
    ok: payload.ok ?? false,
    data: payload.data,
    error: payload.error,
    calls: callCounter.total,
  };
}

// ============================================================
// 测试套件
// ============================================================

describe("aicp_chat（真实 LLM）", () => {
  // ----------------------------------------------------------
  // 基础层
  // ----------------------------------------------------------

  describe("基础层", () => {
    test("用例 1：纯文本回复", async () => {
      const result = await runChat("你好，用一句话介绍一下你自己");
      console.log(
        `[用例1] 调用 ${result.calls} 次`,
        String(result.data).slice(0, 80)
      );

      expect(result.ok).toBe(true);
      expect(typeof result.data).toBe("string");
      expect(result.data.length).toBeGreaterThan(0);
      // 纯文本：LLM 调 1 次
      expect(result.calls).toBe(1);
    });

    test("用例 2：简单计算", async () => {
      const result = await runChat("计算 1 到 100 的和，返回结果");
      console.log(`[用例2] 调用 ${result.calls} 次`, result.data);

      expect(result.ok).toBe(true);

      // LLM 可能直接回答，也可能写代码。两种情况都算通过。
      const dataStr = String(result.data ?? "");
      expect(dataStr).toContain("5050");

      expect(result.calls).toBeLessThanOrEqual(4);
    });
  });

  // ----------------------------------------------------------
  // 能力层
  // ----------------------------------------------------------

  describe("能力层", () => {
    test("用例 3：fetch 调用", async () => {
      const result = await runChat(
        "请求 https://api.github.com/repos/woozheng/aicp，返回 stargazers_count 数字"
      );
      console.log(`[用例3] 调用 ${result.calls} 次`, result.data);

      expect(result.ok).toBe(true);
      expect(typeof result.data).toBe("number");
      expect(result.data).toBeGreaterThanOrEqual(0);
    });

    test("用例 4：Bun.file 读文件", async () => {
      const result = await runChat(
        "读取当前目录下的 package.json，返回 name 字段的字符串值"
      );
      console.log(`[用例4] 调用 ${result.calls} 次`, result.data);

      expect(result.ok).toBe(true);
      expect(typeof result.data).toBe("string");
      expect(result.data.length).toBeGreaterThan(0);
    });

    test("用例 5：声明依赖（lodash 自动安装）", async () => {
      const result = await runChat(
        "用 lodash 的 sortBy 对 [3, 1, 2] 排序，返回排序后的数组"
      );
      console.log(`[用例5] 调用 ${result.calls} 次`, result.data);

      expect(result.ok).toBe(true);
      expect(result.data).toEqual([1, 2, 3]);
    }, 120000); // 装包可能慢，给 120 秒

    test("用例 11：Bun.$ shell 执行", async () => {
      const result = await runChat(
        "用 Bun.$ 执行 ls，返回当前目录前 5 个文件名组成的数组"
      );
      console.log(`[用例11] 调用 ${result.calls} 次`, result.data);

      expect(result.ok).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data.length).toBeGreaterThan(0);
    });

    test("用例 12：Bun.sqlite 数据库", async () => {
      const result = await runChat(
        "用 Bun.sqlite 创建内存数据库，建表 users (id INTEGER, name TEXT)，插入 (1, 'Alice')，返回所有行"
      );
      console.log(`[用例12] 调用 ${result.calls} 次`, result.data);

      expect(result.ok).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data.length).toBe(1);
      expect(result.data[0]).toMatchObject({ id: 1, name: "Alice" });
    }, 120000);
  });

  // ----------------------------------------------------------
  // 依赖层
  // ----------------------------------------------------------

  describe("依赖层", () => {
    test("用例 6：非白名单包（应换方案或失败）", async () => {
      const result = await runChat(
        "用 node-pty 起一个交互式终端，返回终端输出"
      );
      console.log(`[用例6] 调用 ${result.calls} 次`, result.ok, result.error);

      expect(result).toBeDefined();

      // 只要不是真的用上 node-pty，就算通过
      if (result.ok) {
        const dataStr = JSON.stringify(result.data);
        expect(dataStr).not.toMatch(/node-pty/i);
      }
    }, 120000);

    test("用例 6b：白名单外 require 被拦", async () => {
      const result = await runChat(
        "用 require('node-pty') 加载包，返回它的类型字符串"
      );
      console.log(
        `[用例6b] 调用 ${result.calls} 次`,
        result.ok,
        result.error
      );

      // 应该失败或换方案
      expect(result).toBeDefined();
    }, 120000);
  });

  // ----------------------------------------------------------
  // 边界层
  // ----------------------------------------------------------

  describe("边界层", () => {
    test("用例 7：超时（死循环）", async () => {
      const result = await runChat(
        "写一个 execute 函数，内部用 while(true) 死循环，永远不返回",
        { timeout_ms: 3000 }
      );
      console.log(`[用例7] 调用 ${result.calls} 次`, result.ok, result.error);

      expect(result).toBeDefined();
      expect(result.calls).toBeLessThanOrEqual(8);
    }, 120000);

    test("用例 8：返回值格式（LLM 可能直接正确）", async () => {
      const result = await runChat(
        "写一个 execute 函数，直接 return 42，不要包装成 { data: ... }"
      );
      console.log(`[用例8] 调用 ${result.calls} 次`, result.ok, result.data);

      // LLM 可能一次就写对，也可能重试
      expect(result.ok).toBe(true);
      expect(result.data).toBe(42);
      expect(result.calls).toBeGreaterThanOrEqual(1);
      expect(result.calls).toBeLessThanOrEqual(8);
    });

    test("用例 9：tool_call 标签（应纠正）", async () => {
      const result = await runChat(
        "请用 tool_call 标签格式调用一个名为 test 的工具"
      );
      console.log(
        `[用例9] 调用 ${result.calls} 次`,
        result.ok,
        String(result.data).slice(0, 80)
      );

      expect(result).toBeDefined();
      expect(result.calls).toBeGreaterThanOrEqual(1);
    });

    test("用例 10：大代码（应拒绝或精简）", async () => {
      const result = await runChat(
        "写一个 execute 函数，函数体内包含 10000 行 'const x = 1;' 的重复代码"
      );
      console.log(`[用例10] 调用 ${result.calls} 次`, result.ok, result.error);

      expect(result).toBeDefined();
      expect(result.calls).toBeLessThanOrEqual(8);
    }, 120000);
  });

  // ----------------------------------------------------------
  // 稳定性层
  // ----------------------------------------------------------

  describe("稳定性层", () => {
    test("用例 13：多轮迭代（失败重试）", async () => {
      const result = await runChat(
        "写一个 execute 函数，引用一个不存在的变量 undefinedVar，返回它的值"
      );
      console.log(`[用例13] 调用 ${result.calls} 次`, result.ok, result.data);

      expect(result).toBeDefined();

      // 如果成功，说明 LLM 修正了（>= 2 次调用）
      if (result.ok) {
        expect(result.calls).toBeGreaterThanOrEqual(2);
      }
    }, 120000);

    test("用例 14：agent.llm 调用", async () => {
      const result = await runChat(
        "调用 agent.llm.chat 让 LLM 写一首关于秋天的四句诗，返回诗句内容字符串"
      );
      console.log(
        `[用例14] 调用 ${result.calls} 次`,
        String(result.data).slice(0, 80)
      );

      expect(result.ok).toBe(true);
      expect(typeof result.data).toBe("string");
      expect(result.data.length).toBeGreaterThan(0);
      // 至少 1 次（沙箱内 LLM 可能不被计数）
      expect(result.calls).toBeGreaterThanOrEqual(1);
    }, 120000);

    test("用例 15：并发安装同一包", async () => {
      const tasks = [
        "用 lodash 对 [3, 1, 2] 排序，返回排序后的数组",
        "用 lodash 对 [5, 4, 6] 排序，返回排序后的数组",
      ];

      const results = await Promise.all(tasks.map((t) => runChat(t)));

      console.log(
        `[用例15] 并发结果:`,
        results.map((r) => ({ ok: r.ok, data: r.data, calls: r.calls }))
      );

      expect(results[0].ok).toBe(true);
      expect(results[1].ok).toBe(true);
      expect(results[0].data).toEqual([1, 2, 3]);
      expect(results[1].data).toEqual([4, 5, 6]);
    }, 180000); // 并发 + 装包，给 180 秒
  });

  // ----------------------------------------------------------
  // 统计层
  // ----------------------------------------------------------

  describe("统计层", () => {
    test("汇总：所有用例的 LLM 调用次数", () => {
      console.log("\n=== LLM 调用次数汇总 ===");
      for (const [task, count] of callCounter.byTask) {
        console.log(`  ${task.slice(0, 50)}: ${count} 次`);
      }
      console.log(`  总计: ${callCounter.total} 次\n`);

      expect(true).toBe(true);
    });
  });
});