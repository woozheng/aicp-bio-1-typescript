/**
 * aicp_chat — AICP Chat 端点 + TS 运行时
 *
 * 统一 action 模式：action: "chat"（默认）
 *
 * 端点部分：接收 task / messages
 * 运行时部分：LLM 生成 JS 代码 → 沙箱执行 → 多轮迭代
 *
 * 设计目标：
 * - 能力最大化（白名单 API + 自动安装 npm 包）
 * - 防误操作（超时、返回值格式、死循环检测、重试上限）
 * - 稳定（多轮迭代、错误恢复、边界处理）
 * - 无记忆（每次调用独立）
 *
 * 包管理：
 * - LLM 在代码块前用 ~~~packages ... ~~~ 声明依赖
 * - 白名单过滤 + 自动安装 + 缓存
 * - 并发安全（安装锁）
 */

import { Envelop } from "../../../core/Envelop.js";
import type { Agent } from "../../../core/Agent.js";

// ============================================================
// 常量
// ============================================================

const DEFAULT_MAX_ITER = 5;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_CODE_LENGTH = 20000;
const MAX_ERROR_LENGTH = 1000;
const MAX_WHITELIST_ERRORS = 2;

/**
 * 允许自动安装的包白名单。
 * 只包含"工具类"包，安全风险低。
 * 需要更强能力时，在这里加。
 */
const ALLOWED_PACKAGES = new Set([
  // 工具类
  "lodash",
  "dayjs",
  "zod",
  "uuid",
  "nanoid",

  // 网络
  "axios",
  "undici",

  // 解析
  "cheerio",
  "marked",
  "yaml",
  "csv-parse",
  "xml2js",

  // 文件/数据
  "xlsx",
  "pdf-lib",

  // 图像
  "sharp",
]);

// ============================================================
// System Prompt
// ============================================================

const AICP_TS_SYSTEM_PROMPT = `## 你是 AICP 协议运行时（TypeScript 版）。你是执行者，不是助手。

═══════════════════════════════════════
【最高优先级 — 代码生成铁律（不可违反）】
═══════════════════════════════════════
⚠️ 返回格式强制：return { "data": "你的结果" }，字段名必须是 "data"
⚠️ 禁止 console.log / console.error，所有输出通过 return
⚠️ 禁止 try-catch 吞掉错误，错误必须暴露
⚠️ 所有代码必须定义 async function execute(envelop, agent)
⚠️ 禁止顶层执行代码
⚠️ 禁止使用任何原生 function calling 或 tool_call 格式
⚠️ 禁止输出 <tool_call>、<function_call>、<invoke> 等标签

═══════════════════════════════════════
【输出格式 — 三种模式】
═══════════════════════════════════════

## 模式1：纯聊天
直接说人话，友好回复。

## 模式2：写代码执行（不需要额外依赖）
输出 JavaScript 代码块，用 ~~~javascript ... ~~~ 包裹

正确示例：
~~~javascript
async function execute(envelop, agent) {
  const resp = await fetch("https://api.github.com/repos/woozheng/aicp");
  const data = await resp.json();
  return { data: \`Star 数: \${data.stargazers_count}\` };
}
~~~

## 模式3：写代码执行（需要额外依赖）
先用 ~~~packages ... ~~~ 声明依赖，再用 ~~~javascript ... ~~~ 写代码

正确示例：
~~~packages
lodash
dayjs
~~~
~~~javascript
async function execute(envelop, agent) {
  const _ = require("lodash");
  const dayjs = require("dayjs");

  const items = [3, 1, 2];
  const sorted = _.sortBy(items);
  const now = dayjs().format("YYYY-MM-DD");

  return { data: { sorted, now } };
}
~~~

⚠️ 依赖必须在白名单内。白名单外的包会被拒绝。
⚠️ 依赖会自动安装，无需手动 bun add。

═══════════════════════════════════════
【沙箱可用 API】
═══════════════════════════════════════
- fetch(url, options)：HTTP 请求（全局函数）
- agent.llm.chat(messages)：调 LLM，返回 string
- agent.llm.chat_json(messages)：调 LLM，返回 dict
- agent.system.call(envelop)：调其他插件
- Bun.file(path).text() / Bun.file(path).json()：读文件
- Bun.write(path, content)：写文件
- Bun.spawn([...], {...})：子进程
- Bun.$：shell 执行
- Bun.sqlite：SQLite 数据库
- Bun.Glob：文件匹配
- Bun.which：查找命令
- Bun.sleep：睡眠
- require(name)：加载白名单包

═══════════════════════════════════════
【代码自检规则】
═══════════════════════════════════════
1. 外部调用（API/网络/文件）必须检查返回是否为空，空数据立即 throw new Error
2. 文件写入后必须 assert 文件存在且大小 > 0
3. 中间关键变量为空立即 throw new Error
4. 禁止空的 catch 块

═══════════════════════════════════════
【重试规则 — 重要】
═══════════════════════════════════════
⚠️ 如果某个包不在白名单，不要反复重试。直接回复"这个包不支持，建议用 X 替代"。
⚠️ 如果代码执行失败，分析原因后一次性修正，不要每次只改一点点。
⚠️ 如果连续两次失败原因相同，直接回复"无法完成"，不要继续尝试。
⚠️ 禁止 while(true) / for(;;) 等死循环，必须用有限循环。

═══════════════════════════════════════
【LLM 调用规范】
═══════════════════════════════════════
- 需要自然语言理解、文本生成、翻译、摘要、分类、推理时，调用 agent.llm
- 不需要 LLM 的纯计算、文件操作、数据转换，禁止调用 LLM（浪费 token）

文本调用：
  const result = await agent.llm.chat([
    { role: "system", content: "..." },
    { role: "user", content: "..." }
  ]);
  // result 是 string

JSON 调用：
  const result = await agent.llm.chat_json([...]);
  // result 是 dict

⚠️ agent.llm 已经配好了 API Key，直接调就行。

═══════════════════════════════════════
【图片分析（多模态）】
═══════════════════════════════════════
需要分析图片（识别物体、读文字、理解场景）时，用 content 数组格式传图片：

~~~javascript
async function execute(envelop, agent) {
  const imgPath = "data/uploads/xxx.png";

  // 1. 读图片，转 base64
  const file = Bun.file(imgPath);
  const buffer = await file.arrayBuffer();
  const b64 = Buffer.from(buffer).toString("base64");

  // 2. 推测 MIME（简单版，根据扩展名）
  const ext = imgPath.split(".").pop()?.toLowerCase() ?? "png";
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : \`image/\${ext}\`;

  // 3. 调多模态 LLM（content 用数组格式，不是字符串）
  const result = await agent.llm.chat([
    {
      role: "user",
      content: [
        { type: "text", text: "分析这张图片，描述内容、识别物体、读取文字" },
        { type: "image_url", image_url: { url: \`data:\${mime};base64,\${b64}\` } }
      ]
    }
  ]);

  return { data: result };
}
~~~

⚠️ content 必须是数组格式（不是字符串），否则模型看不到图片。
⚠️ 模型必须支持视觉（如 claude-sonnet-4-6、gpt-4o、doubao-vision 等）。
⚠️ 如果模型不支持视觉，会报 "model doesn't support image"，此时直接回复"当前模型不支持图片分析"。
⚠️ 禁止编造图片内容。如果无法真正分析，直接说无法分析，不要返回假数据。

═══════════════════════════════════════
【当前运行环境】
═══════════════════════════════════════
- 运行时: Bun
- 语言: JavaScript (ES2022+)
- 可用: fetch / Bun.file / Bun.write / Bun.spawn / Bun.$ / Bun.sqlite / Bun.Glob / Bun.which / WebSocket
- 超时限制: ${DEFAULT_TIMEOUT_MS / 1000} 秒
- 最大迭代: ${DEFAULT_MAX_ITER} 轮
`;

// ============================================================
// 类型
// ============================================================

interface ExecResult {
  ok: boolean;
  data?: any;
  error?: string;
}

interface ChatParams {
  task?: string;
  messages?: Array<{ role: string; content: any }>;
  max_iter?: number;
  timeout_ms?: number;
  model?: string;
  role?: string;
}

// ============================================================
// 包管理
// ============================================================

const _installedPackages = new Set<string>();
let _installLock: Promise<void> | null = null;

/**
 * 确保包已安装。
 * - 白名单过滤
 * - 缓存已装的
 * - 并发安全（安装锁）
 */
async function ensurePackages(packages: string[]): Promise<void> {
  console.log(`[ensurePackages] 开始: ${JSON.stringify(packages)}`);

  const rejected = packages.filter((p) => !ALLOWED_PACKAGES.has(p));
  if (rejected.length > 0) {
    throw new Error(`以下包不在白名单：${rejected.join(", ")}`);
  }

  const missing = packages.filter((p) => !_installedPackages.has(p));
  console.log(`[ensurePackages] 需要安装: ${JSON.stringify(missing)}`);

  if (missing.length === 0) return;

  if (_installLock) {
    await _installLock;
    return ensurePackages(packages);
  }

  _installLock = doInstall(missing);
  try {
    await _installLock;
  } finally {
    _installLock = null;
  }
}

async function doInstall(packages: string[]): Promise<void> {
  const reallyMissing: string[] = [];
  for (const pkg of packages) {
    try {
      require.resolve(pkg);
      _installedPackages.add(pkg);
      console.log(`[ensurePackages] 已存在: ${pkg}`);
    } catch {
      reallyMissing.push(pkg);
    }
  }

  console.log(`[ensurePackages] 真正需要装: ${JSON.stringify(reallyMissing)}`);
  if (reallyMissing.length === 0) return;

  const proc = Bun.spawn(["bun", "add", ...reallyMissing], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  console.log(`[ensurePackages] bun add 退出码: ${exitCode}`);

  if (exitCode !== 0) {
    let stderr = "";
    try {
      stderr = await new Response(proc.stderr).text();
    } catch {}
    console.log(`[ensurePackages] stderr: ${stderr}`);
    throw new Error(`安装失败（exit=${exitCode}）：${stderr.slice(0, 500)}`);
  }

  for (const pkg of reallyMissing) {
    _installedPackages.add(pkg);
  }

  console.log(`[ensurePackages] 安装完成: ${JSON.stringify(reallyMissing)}`);
}

/**
 * 从 LLM 输出中提取 ~~~packages ... ~~~ 块
 */
function extractPackages(text: string): string[] {
  const m = text.match(/~~~packages\s*\n([\s\S]*?)~~~/);
  if (!m) return [];

  return m[1]
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"))
    .map((s) => {
      // 去掉版本号：lodash@4.17.21 → lodash
      // 去掉 scope 里的 @：@types/node → @types/node
      if (s.startsWith("@")) {
        const parts = s.split("@");
        return "@" + parts[1];
      }
      return s.split("@")[0];
    })
    .filter((s) => s.length > 0);
}

// ============================================================
// 主入口
// ============================================================

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  // 统一 action 模式
  const action = envelop.payload?.action ?? "chat";

  // 兼容两种传参：payload.params.xxx 或 payload.xxx
  let params: ChatParams = envelop.payload?.params ?? {};
  if (Object.keys(params).length === 0) {
    params = { ...envelop.payload };
  }

  // action 校验
  if (action !== "chat") {
    envelop.payload = { ok: false, error: `未知 action: ${action}` };
    return envelop;
  }

  // 参数解析
  const task = params.task ?? "";
  const messages = params.messages ?? [];
  const maxIter = clamp(params.max_iter ?? DEFAULT_MAX_ITER, 1, 20);
  const timeoutMs = clamp(params.timeout_ms ?? DEFAULT_TIMEOUT_MS, 1000, 300000);
  const model = params.model;
  const role = params.role ?? "code";

  // 构造 messages
  let userMessages: Array<{ role: string; content: any }>;
  if (messages && messages.length > 0) {
    userMessages = messages;
  } else if (task) {
    userMessages = [{ role: "user", content: task }];
  } else {
    envelop.payload = { ok: false, error: "需要 task 或 messages 参数" };
    return envelop;
  }

  // LLM 检查
  if (!agent.llm) {
    envelop.payload = { ok: false, error: "LLM not available" };
    return envelop;
  }

  // 构造完整 messages
  const fullMessages: Array<{ role: string; content: any }> = [
    { role: "system", content: AICP_TS_SYSTEM_PROMPT },
    ...userMessages,
  ];

  // 白名单错误计数器
  let whitelistErrorCount = 0;

  // 多轮迭代
  for (let iter = 0; iter < maxIter; iter++) {
    // 调 LLM
    let raw: string;
    try {
      raw = await agent.llm.chat(fullMessages as any, model, role);
    } catch (e: any) {
      envelop.payload = { ok: false, error: `LLM 调用失败: ${e?.message ?? e}` };
      return envelop;
    }

    // 空响应
    if (!raw || !raw.trim()) {
      envelop.payload = { ok: true, data: "" };
      return envelop;
    }

    // 检测 tool_call 标签（禁止）
    if (hasToolCallTag(raw)) {
      fullMessages.push({ role: "assistant", content: raw });
      fullMessages.push({
        role: "user",
        content:
          "不要输出 tool_call 标签！请直接写 JavaScript 代码块（~~~javascript ... ~~~）或纯文本回复。",
      });
      continue;
    }

    // 提取依赖
    const packages = extractPackages(raw);

    // 提取 JS 代码块
    const code = extractJsCodeBlock(raw);

    // 纯文本回复
    if (!code) {
      envelop.payload = { ok: true, data: raw };
      return envelop;
    }

    // 代码长度检查
    if (code.length > MAX_CODE_LENGTH) {
      fullMessages.push({ role: "assistant", content: raw });
      fullMessages.push({
        role: "user",
        content: `代码过长（${code.length} > ${MAX_CODE_LENGTH}），请精简后重新输出。`,
      });
      continue;
    }

    // 安装依赖
    if (packages.length > 0) {
      try {
        await ensurePackages(packages);
        whitelistErrorCount = 0;
      } catch (e: any) {
        const errMsg = e?.message ?? String(e);

        // 白名单错误计数
        if (errMsg.includes("白名单")) {
          whitelistErrorCount++;
          if (whitelistErrorCount >= MAX_WHITELIST_ERRORS) {
            envelop.payload = {
              ok: false,
              error: `连续 ${whitelistErrorCount} 次白名单错误，终止。请改用白名单内的包。原始错误：${errMsg}`,
            };
            return envelop;
          }
        }

        fullMessages.push({ role: "assistant", content: raw });
        fullMessages.push({
          role: "user",
          content: `依赖安装失败：${errMsg}\n请改用白名单内的包，或换其他方案。`,
        });
        continue;
      }
    }

    // 沙箱执行
    const execResult = await executeInSandbox(code, envelop, agent, timeoutMs);

    // 执行成功
    if (execResult.ok) {
      envelop.payload = { ok: true, data: execResult.data };
      return envelop;
    }

    // 检测沙箱里的白名单错误
    if (execResult.error?.includes("白名单")) {
      whitelistErrorCount++;
      if (whitelistErrorCount >= MAX_WHITELIST_ERRORS) {
        envelop.payload = {
          ok: false,
          error: `连续 ${whitelistErrorCount} 次白名单错误，终止。${execResult.error}`,
        };
        return envelop;
      }
    }

    // 执行失败 → 喂回 LLM
    fullMessages.push({ role: "assistant", content: raw });
    fullMessages.push({
      role: "user",
      content: execResult.error ?? "执行失败，请修正代码后重新输出完整代码块。",
    });
  }

  // 达到最大迭代
  envelop.payload = {
    ok: false,
    error: `达到最大迭代次数 (${maxIter})，任务未完成。`,
  };
  return envelop;
}

// ============================================================
// 代码块提取
// ============================================================

function extractJsCodeBlock(text: string): string {
  // ~~~javascript ... ~~~
  let m = text.match(/~~~(?:javascript|js)\s*\n([\s\S]*?)~~~/);
  if (m) return m[1].trim();

  // ```javascript ... ```
  m = text.match(/```(?:javascript|js)\s*\n([\s\S]*?)```/);
  if (m) return m[1].trim();

  return "";
}

// ============================================================
// tool_call 检测
// ============================================================

function hasToolCallTag(text: string): boolean {
  if (/<\w*:?\s*tool_call\s*>/i.test(text)) return true;
  if (text.includes("tool_calls")) return true;
  return false;
}

// ============================================================
// 死循环检测
// ============================================================

function detectInfiniteLoop(code: string): string | null {
  // while (true) / while(true) / while ( 1 ) / while(1)
  if (/while\s*\(\s*(?:true|1)\s*\)/.test(code)) {
    return "while(true)";
  }

  // for (;;)
  if (/for\s*\(\s*;\s*;\s*\)/.test(code)) {
    return "for(;;)";
  }

  // do { ... } while (true)
  if (/do\s*\{[\s\S]*?\}\s*while\s*\(\s*(?:true|1)\s*\)/.test(code)) {
    return "do-while(true)";
  }

  return null;
}

// ============================================================
// 沙箱执行
// ============================================================

async function executeInSandbox(
  code: string,
  envelop: Envelop,
  agent: Agent,
  timeoutMs: number
): Promise<ExecResult> {
  // 检查：必须有 execute 函数
  if (
    !/async\s+function\s+execute\s*\(/.test(code) &&
    !/function\s+execute\s*\(/.test(code)
  ) {
    return {
      ok: false,
      error:
        "代码必须定义 async function execute(envelop, agent)。请修正后重新输出。",
    };
  }

  // 死循环静态检测
  const loop = detectInfiniteLoop(code);
  if (loop) {
    return {
      ok: false,
      error: `检测到死循环（${loop}），已拒绝执行。请改用有限循环，例如 for (let i = 0; i < N; i++)。`,
    };
  }

  // 构造沙箱 API
  const sandboxApi = buildSandboxApi(agent);

  try {
    const keys = Object.keys(sandboxApi);
    const values = Object.values(sandboxApi);

    const wrapped = `
${code}
return execute(envelop, agent);
`;

    const fn = new Function("envelop", "agent", ...keys, wrapped);

    // 超时执行
    const result = await withTimeout(
      Promise.resolve().then(() => fn(envelop, agent, ...values)),
      timeoutMs
    );

    // 返回值校验
    if (!result || typeof result !== "object") {
      return {
        ok: false,
        error: `execute 必须 return { data: ... }，实际返回 ${typeof result}`,
      };
    }

    if (!("data" in result)) {
      return {
        ok: false,
        error: `execute 返回值缺少 "data" 字段。返回：${safeStringify(result).slice(0, 200)}`,
      };
    }

    return { ok: true, data: result.data };
  } catch (e: any) {
    const errMsg = e?.stack ?? e?.message ?? String(e);
    return {
      ok: false,
      error: `代码执行失败：\n${String(errMsg).slice(0, MAX_ERROR_LENGTH)}\n\n请修正代码后重新输出完整代码块。`,
    };
  }
}

// ============================================================
// 沙箱 API 构造
// ============================================================

function buildSandboxApi(agent: Agent): Record<string, any> {
  // console 被限制
  const safeConsole = {
    log: (..._args: any[]) => {
      throw new Error("禁止 console.log。所有输出请通过 return { data: ... }");
    },
    error: (..._args: any[]) => {
      throw new Error("禁止 console.error。所有输出请通过 return { data: ... }");
    },
    warn: () => {},
    info: () => {},
    debug: () => {},
  };

  // Bun API
  const safeBun: Record<string, any> = {
    file: typeof Bun !== "undefined" ? Bun.file : undefined,
    write: typeof Bun !== "undefined" ? Bun.write : undefined,
    spawn: typeof Bun !== "undefined" ? Bun.spawn : undefined,
    hash: typeof Bun !== "undefined" ? Bun.hash : undefined,
    env: typeof Bun !== "undefined" ? Bun.env : undefined,
    sleep: typeof Bun !== "undefined" ? Bun.sleep : undefined,
    which: typeof Bun !== "undefined" ? Bun.which : undefined,
    Glob: typeof Bun !== "undefined" ? Bun.Glob : undefined,
    $: typeof Bun !== "undefined" ? Bun.$ : undefined,
    sqlite: typeof Bun !== "undefined" ? (Bun as any).sqlite : undefined,
    serve: typeof Bun !== "undefined" ? Bun.serve : undefined,
  };

  // 受限 require
  const safeRequire = (name: string) => {
    const normalized = name.startsWith("@")
      ? "@" + name.split("@")[1]
      : name.split("@")[0];

    if (!ALLOWED_PACKAGES.has(normalized)) {
      throw new Error(
        `包 "${name}" 不在白名单。允许的包：${Array.from(ALLOWED_PACKAGES).join(", ")}`
      );
    }

    try {
      return require(normalized);
    } catch (e: any) {
      throw new Error(`加载包 "${name}" 失败: ${e?.message ?? e}`);
    }
  };

  return {
    // 网络
    fetch: globalThis.fetch,

    // 控制台（受限）
    console: safeConsole,

    // Bun API
    Bun: safeBun,

    // 受限 require
    require: safeRequire,

    // 内置对象
    JSON,
    Math,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Promise,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Symbol,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    ReferenceError,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    Buffer,
    structuredClone:
      typeof structuredClone !== "undefined" ? structuredClone : undefined,
    AbortController,
    AbortSignal,

    // AICP
    Envelop,
    agent,
  };
}

// ============================================================
// 工具函数
// ============================================================

function clamp(n: number, min: number, max: number): number {
  if (typeof n !== "number" || isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function safeStringify(obj: any): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`执行超时（${ms}ms）`)), ms)
    ),
  ]);
}

// ============================================================
// help
// ============================================================

export function help() {
  return {
    route: "builtins/tools/aicp_chat",
    description:
      "AICP Chat — 端点 + TS 运行时（LLM 生成 JS 代码 + 沙箱执行 + 自动安装依赖 + 图片分析）",
    input: {
      action: "chat（默认）",
      task: "任务描述（自然语言）",
      messages: "消息列表（可选，优先于 task）",
      model: "模型名（可选）",
      role: "角色（可选，默认 code）",
      max_iter: `最大迭代次数（默认 ${DEFAULT_MAX_ITER}）`,
      timeout_ms: `超时毫秒数（默认 ${DEFAULT_TIMEOUT_MS}）`,
    },
    output: {
      ok: "是否成功",
      data: "执行结果",
      error: "错误信息",
    },
    features: [
      "白名单 API：fetch / Bun.file / Bun.write / Bun.spawn / Bun.$ / Bun.sqlite / Bun.Glob / Bun.which",
      `白名单 npm 包：${Array.from(ALLOWED_PACKAGES).join(", ")}`,
      "自动安装依赖：LLM 用 ~~~packages ... ~~~ 声明，自动 bun add",
      "并发安全：安装锁，避免并发冲突",
      "缓存已装包：不重复安装",
      "超时限制：默认 30 秒",
      "多轮迭代：默认 5 轮，失败喂回 LLM 修正",
      "死循环检测：静态检测 while(true) / for(;;)，拒绝执行",
      "白名单错误上限：连续 2 次白名单错误终止",
      "★ 图片分析：支持 content 数组格式传图给多模态模型",
    ],
  };
}