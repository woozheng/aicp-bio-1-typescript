/**
 * main_agent — 主控制台 Agent（信息流驱动）
 *
 * 统一 action 模式：action: "chat"（默认）
 *
 * 核心：
 * - 信息流（InformationFlow）：持久化 AI 的思考过程
 * - LLM 输出解析：think + call + args
 * - 递归处理：每轮一个动作，执行后继续
 * - 异步回调：create_tool / fix_tool 等慢操作后台执行
 * - 中断 / 熔断 / 会话锁
 */

import { readFile, writeFile, mkdir, rename, readdir, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { Envelop } from "../../../core/Envelop.js";
import type { Agent } from "../../../core/Agent.js";

// ============================================================
// 常量
// ============================================================

const MEMORY_DIR = "data/memories/main_agent";
const EXPERIENCE_DIR = join(MEMORY_DIR, "experiences");
const TASKBOARD_DIR = join(MEMORY_DIR, "taskboards");
const FLOWS_DIR = join(MEMORY_DIR, "flows");

const MAX_RECURSION_DEPTH = 40;
const MAX_FLOW_ENTRIES = 500;
const THINK_MAX_CHARS = 1600;
const MAX_STREAM_TIME = 240;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILES = 5;

const VALID_CALLS = new Set(["use_tool", "reply"]);

// ============================================================
// Logger
// ============================================================

const Logger = {
  info: (msg: string) => console.log(`[main_agent] ${msg}`),
  warn: (msg: string) => console.warn(`[main_agent] ${msg}`),
  error: (msg: string, e?: any) => console.error(`[main_agent] ${msg}`, e ?? ""),
  debug: (msg: string) => { /* 静默 */ },
};

function now(): string {
  return new Date().toISOString();
}

// ============================================================
// 经验背包 / 任务看板 读写
// ============================================================
async function loadActiveSkill(sessionId: string): Promise<string> {
  const file = join("data/memories/main_agent/active_skills", `${sessionId}_skill.txt`);
  if (!existsSync(file)) return "";
  try {
    return (await readFile(file, "utf-8")).trim();
  } catch {
    return "";
  }
}
async function loadExperience(sessionId: string): Promise<string> {
  const file = join(EXPERIENCE_DIR, `${sessionId}_backpack.txt`);
  if (!existsSync(file)) return "";
  try {
    return (await readFile(file, "utf-8")).trim();
  } catch {
    return "";
  }
}

async function loadTaskboard(sessionId: string): Promise<string> {
  const file = join(TASKBOARD_DIR, `${sessionId}_taskboard.txt`);
  if (!existsSync(file)) return "";
  try {
    return (await readFile(file, "utf-8")).trim();
  } catch {
    return "";
  }
}

// ============================================================
// WebSocket 推送
// ============================================================

async function wsPush(agent: Agent, channel: string, data: any): Promise<number> {
  try {
    const result = await agent.system.call(new Envelop({
      sender: "builtins/agents/main_agent",
      receiver: "os/_websocket",
      payload: { action: "push", channel_id: channel, data },
    }));
    return result?.payload?.sent ?? 0;
  } catch (e: any) {
    Logger.warn(`[WS] push 失败: ${e?.message ?? e}`);
    return 0;
  }
}

async function pushProgress(agent: Agent, sessionId: string, step: string, msg: string): Promise<void> {
  await wsPush(agent, `pa_${sessionId}`, { type: "progress", step, msg, message: msg });
}

async function pushChat(agent: Agent, sessionId: string, content: string): Promise<void> {
  await wsPush(agent, `pa_${sessionId}`, { type: "chat", content });
}

async function pushStream(agent: Agent, sessionId: string, chunk: string): Promise<void> {
  await wsPush(agent, `pa_${sessionId}`, { type: "summary_stream", chunk });
}

async function pushError(agent: Agent, sessionId: string, content: string): Promise<void> {
  await wsPush(agent, `pa_${sessionId}`, { type: "error", content });
}

// ============================================================
// 信息流
// ============================================================

class InformationFlow {
  sessionId: string;
  flowFile: string;
  private _flow: any[] = [];

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.flowFile = join(MEMORY_DIR, `${sessionId}_flow.json`);
    this._load();
  }

  private _load(): void {
    if (!existsSync(this.flowFile)) {
      this._flow = [];
      return;
    }
    try {
      const raw = readFileSync(this.flowFile, "utf-8");
      const data = JSON.parse(raw);
      this._flow = Array.isArray(data) && data.length > MAX_FLOW_ENTRIES
        ? data.slice(-MAX_FLOW_ENTRIES)
        : (Array.isArray(data) ? data : []);
    } catch (e) {
      Logger.error(`加载信息流失败: ${e}`);
      this._flow = [];
    }
  }

  async _save(): Promise<void> {
    const content = JSON.stringify(this._flow, null, 2);
    const rootFile = this.flowFile;

    // 原子写根目录
    await mkdir(MEMORY_DIR, { recursive: true });
    const tmpPath = `${rootFile}.tmp`;
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, rootFile);

    // 归档（今天的条目）
    const dateKey = new Date().toISOString().slice(0, 10);
    const flowDir = join(FLOWS_DIR, dateKey);
    await mkdir(flowDir, { recursive: true });

    const today = dateKey;
    const todayEntries = this._flow.filter((e) => {
      const ts = e?.timestamp ?? "";
      return ts.startsWith(today);
    });

    if (todayEntries.length === 0) return;

    const dateFile = join(flowDir, `${this.sessionId}.json`);
    const dateContent = JSON.stringify(todayEntries, null, 2);
    const tmpPath2 = `${dateFile}.tmp`;
    await writeFile(tmpPath2, dateContent, "utf-8");
    await rename(tmpPath2, dateFile);
  }

  async appendUser(content: string): Promise<void> {
    this._flow.push({
      timestamp: now(),
      from: "user",
      content,
    });
    await this._save();
  }

  async appendAi(think: string, output: any): Promise<void> {
    const call = output?.call ?? "";
    const validCalls = new Set([
      "reply", "ask_user", "use_tool",
      "create_tool", "fix_tool", "remove_tool",
      "query_plugin", "aicp_chat", "add_experience",
    ]);
    if (!validCalls.has(call)) return;

    const content = output?.content ?? "";
    if (isLlmErrorString(content)) {
      Logger.warn(`appendAi: 检测到 LLM 错误包装，跳过写入: ${content.slice(0, 100)}`);
      return;
    }

    this._flow.push({
      timestamp: now(),
      from: "ai",
      think,
      call,
      content: output?.content,
      args: output?.args,
      retain: output?.retain ?? 0,
    });
    await this._save();
  }

  async appendSystem(action: string, resultThink: string, detail?: any, extra?: any, retain: number = 1): Promise<void> {
    const entry: any = {
      timestamp: now(),
      from: "system",
      action,
      result: resultThink,
      detail: detail ?? {},
      retain,
    };
    if (extra) entry.extra = extra;
    this._flow.push(entry);
    await this._save();
  }

  getFlow(): any[] {
    return this._flow;
  }

  clear(): void {
    this._flow = [];
  }

    getContext(limit: number = 20): string {
    if (this._flow.length === 0) return "（暂无对话记录）";

    const entries = this._flow.slice(-limit);
    const lines: string[] = [];
    const total = entries.length;
    const IND = "  ";

    const NOISE = ["抱歉，处理过程中出现错误", "请稍后重试", "暂时不可用"];

    const isNoise = (text: string) => {
      if (!text) return true;
      return NOISE.some((k) => text.includes(k));
    };

    const shrink = (text: string, max: number) => {
      if (!text) return "";
      if (text.length <= max) return text;
      return text.slice(0, max) + `... (已收缩，共 ${text.length} 字)`;
    };

    const indentBlock = (text: string, level: number) => {
      const pad = IND.repeat(level);
      return text.split("\n").map((l) => (l ? pad + l : l)).join("\n");
    };

    // ★ 预计算：每条 entry 距离最近几条 ai 消息
    const aiDistances: number[] = new Array(entries.length);
    let aiCount = 0;
    for (let i = total - 1; i >= 0; i--) {
      aiDistances[i] = aiCount;
      if (entries[i]?.from === "ai") aiCount++;
    }

    for (let idx = 0; idx < entries.length; idx++) {
      const entry = entries[idx];
      const tsFull = entry?.timestamp ?? "";
      const ts = tsFull ? tsFull.slice(5, 19) : "";
      const from = entry?.from ?? "";
      const distance = aiDistances[idx];

      if (from === "user") {
        const content = entry?.content ?? "";
        if (content) lines.push(`[${ts}] 👤 ${content}`);
      } else if (from === "ai") {
        const think = entry?.think ?? "";
        const content = entry?.content ?? "";
        const call = entry?.call ?? "";
        const args = entry?.args ?? {};
        const retain = entry?.retain ?? 0;
        const inRetain = retain <= 0 || distance < retain;

        if (think) lines.push(`${IND}[${ts}] 💭 ${think}`);

        if (content && (call === "reply" || call === "ask_user") && !isNoise(content)) {
          lines.push(`${IND}[${ts}] 🤖 ${content}`);
        }

        if (call && call !== "reply" && call !== "ask_user") {
          const argsStr = JSON.stringify(args, null, 2);
          const display = inRetain ? argsStr : shrink(argsStr, 300);
          lines.push(`${IND}${IND}[${ts}] 🔧 调用 ${call}`);
          lines.push(indentBlock(display, 3));
        }
      } else if (from === "system") {
        const action = entry?.action ?? "";
        const result = entry?.result ?? "";
        const detail = entry?.detail ?? {};
        const retain = entry?.retain ?? 0;
        const inRetain = retain <= 0 || distance < retain;

        if (action === "call_start") {
          const callId = detail?.call_id ?? "";
          const target = detail?.target ?? "";
          const status = detail?.status ?? "pending";
          const paramsStr = JSON.stringify(detail?.params ?? {}, null, 2);
          const display = inRetain ? paramsStr : shrink(paramsStr, 200);
          const tag = status === "processing" ? "⏳" : status === "completed" ? "✅" : "";
          lines.push(`${IND}${IND}${IND}[${ts}] 📤 ${target} [id=${callId}] ${tag}`);
          lines.push(indentBlock(display, 4));
        } else if (action === "call_end") {
          const callId = detail?.call_id ?? "";
          const target = detail?.target ?? "";
          const resultStr = JSON.stringify(detail?.result ?? {}, null, 2);
          const display = inRetain ? resultStr : shrink(resultStr, 200);
          lines.push(`${IND}${IND}${IND}[${ts}] ✅ ${target} 调用完成 [id=${callId}]`);
          lines.push(`${IND}${IND}${IND}${IND}结果：`);
          lines.push(indentBlock(display, 4));
        } else if (action === "async_processing") {
          const traceId = (detail?.trace_id ?? "").slice(0, 8);
          lines.push(`${IND}${IND}${IND}[${ts}] ⏳ 已提交 [trace=${traceId}]`);
        } else if (action === "async_callback") {
          const callId = detail?.call_id ?? "";
          const traceId = (detail?.trace_id ?? "").slice(0, 8);
          const matched = detail?.matched ?? false;
          const resultStr = JSON.stringify(detail?.result ?? {}, null, 2);
          const display = inRetain ? resultStr : shrink(resultStr, 200);
          const matchStr = matched ? "✅" : "⚠️";
          lines.push(`${IND}${IND}${IND}[${ts}] 📨 [id=${callId}][trace=${traceId}] ${matchStr}`);
          lines.push(indentBlock(display, 4));
        } else if (action === "task_summary") {
          lines.push(`${IND}${IND}${IND}[${ts}] 📋 ${result}`);
        } else if (action === "call_error") {
          const callId = detail?.call_id ?? "";
          const error = detail?.error ?? "";
          const display = inRetain ? error : shrink(error, 200);
          lines.push(`${IND}${IND}${IND}[${ts}] ❌ [id=${callId}]`);
          lines.push(indentBlock(display, 4));
        } else if (action === "validation_error") {
          const fullResult = entry?.extra?.full_result ?? result;
          lines.push(`${IND}${IND}${IND}[${ts}] ❌ ${fullResult}`);
        } else {
          if (result && !isNoise(result)) {
            lines.push(`${IND}${IND}${IND}[${ts}] 📊 ${result}`);
          }
          const fullResult = entry?.extra?.full_result ?? "";
          if (fullResult) {
            const display = inRetain ? fullResult : shrink(fullResult, 200);
            lines.push(indentBlock(display, 4));
          }
        }
      }
    }

    return lines.join("\n");
  }
}

// ============================================================
// LLM 错误检测（对齐 llm.ts）
// ============================================================

const ERROR_PREFIXES = [
  "[LLM stream error:",
  "[LLM请求失败:",
  "[系统错误:",
  "[服务请求超时",
  "[模型返回空响应",
  "[LLM 达到最大重试次数]",
  "[LLM 未配置]",
  "[空响应]",
];

function isLlmErrorString(text: any): boolean {
  if (typeof text !== "string" || !text) return false;
  return ERROR_PREFIXES.some((p) => text.startsWith(p));
}



// ============================================================
// LLM 输出解析
// ============================================================

class LLMOutputParser {
  private _maxExtractLen = 150000;

  private _checkMissingContentBlock(result: any): string {
    if (result?.call !== "use_tool") return "";
    const args = result.args;
    if (!args || typeof args !== "object") return "";

    const target = args.target ?? "";
    const action = args.action ?? "";
    const params = args.params ?? {};
    const p = (typeof params === "object" && params !== null) ? params : {};

        // ★ clear action 不需要 content
    const isClear = action === "clear";

    if (target === "builtins/tools/add_experience") {
      if (isClear) return "";
      if (!("experience" in p)) return "add_experience（需要 experience）";
    } else if (target === "builtins/tools/add_task_board") {
      if (isClear) return "";
      if (!("content" in p)) return "add_task_board（需要 content）";
    } else if (target === "builtins/tools/aicp_chat") {
      if (!("task" in p)) return "aicp_chat（需要 task）";
    } else if (target === "builtins/tools/fix_tool") {
      if (!("issue" in p)) return "fix_tool（需要 issue）";
    } else if (target === "os/file_utils_api") {
      if (action === "write_file" || action === "append_file" || action === "apply_patch") {
        if (!("content" in p)) return `${action}（需要 content）`;
      }
    }
    return "";
  }

  parse(raw: string): any {
    if (typeof raw !== "string") {
      return this._errorResponse("输入类型错误", "抱歉，处理过程中出现错误，请稍后重试");
    }

    try {
      let s = raw.trim();
      if (!s) return this._errorResponse("空输入", "抱歉，我遇到了一些问题...");
      if (s.length > this._maxExtractLen) {
        Logger.warn(`LLM 输出过长（${s.length}），截断`);
        s = s.slice(0, this._maxExtractLen);
      }

            // 第一步：提取 @@CONTENT@@ 块
      const { contentBlock, cleaned } = this._extractContentBlock(s);

      // 第一步半：单行 patch 兜底检测
      // 模型有时会把多行 patch 压成一行，无法还原。
      // 检测：块内容非空、无换行、且含 diff 语义字符 → 触发重试。
      if (contentBlock !== null && !contentBlock.includes("\n")) {
        const diffMarkers = ["@@ ", "--- ", "+++ ", "@@ -", "--- a/", "+++ b/"];
        if (diffMarkers.some((m) => contentBlock.includes(m))) {
          Logger.warn(`检测到单行 patch（换行被压缩），触发重试。内容前 200 字: ${contentBlock.slice(0, 200)}`);
          return this._makeRetry(
            "@@CONTENT@@ 块内是单行 patch，换行被压缩。" +
            "diff 的每一行必须独立成行（@@ / --- / +++ / 空格 / - / + 开头各占一行），" +
            "请重新输出，块内保留换行。"
          );
        }
      }

      // 第二步：判断是否有 JSON 意图
      const hasJsonIntent = this._hasJsonIntent(cleaned);

      // 第三步：查找 JSON
      const { result, jsonFound } = this._findAndParseJson(cleaned);

      // 第四步：分流
      if (jsonFound && result && typeof result === "object") {
        // ★ 额外检查：如果没有 JSON 意图，说明是误判
        if (!hasJsonIntent) {
          Logger.info("检测到 {…} 但无 JSON 意图，当纯文本处理");
          return this._makeReply("LLM 直接回复", s);
        }

        const callVal = this._normalizeCallField(result);
        if (callVal === null) {
          Logger.warn("JSON 缺少 call 字段，触发重试");
          const preview = JSON.stringify(result).slice(0, 300);
          return this._makeRetry(`JSON 缺少 call 字段|${preview}`);
        }
                result.call = callVal;
        if (contentBlock !== null) {
          this._injectContentBlock(result, contentBlock);
        } else {
          // ★ 检测：需要 content 块但块缺失
          const missing = this._checkMissingContentBlock(result);
          if (missing) {
            Logger.warn(`检测到缺少 @@CONTENT@@ 块: ${missing}`);
            return this._makeRetry(
              `${missing} 需要大文本参数，但你没有输出 @@CONTENT@@ 块。` +
              `请在 JSON 之后另起一行，写 @@CONTENT@@ ... @@END_CONTENT@@，` +
              `块内放内容。注意：块内必须保留换行。`
            );
          }
        }
        return this._ensureDefaults(result);
      }

      if (hasJsonIntent) {
        Logger.warn("检测到 JSON 意图但解析失败，触发重试");
        return this._makeRetry(`JSON 解析失败|${s.slice(0, 300)}`);
      }

      Logger.info("纯文本回复");
      return this._makeReply("LLM 直接回复", s);
    } catch (e: any) {
      Logger.error(`LLM 输出解析异常: ${e}`);
      return this._errorResponse("解析异常", "抱歉，处理过程中出现错误，请稍后重试");
    }
  }

  private _hasJsonIntent(raw: string): boolean {
    if (!raw) return false;
    const s = raw.trim();
    if (s.startsWith("{") && s.endsWith("}")) return true;
    const idx = s.indexOf("{");
    if (idx === -1) return false;
    const tail = s.slice(idx, idx + 200);
    const keys = ['"call"', "'call'", '"args"', "'args'", '"target"', "'target'", '"think"', "'think'"];
    return keys.some((k) => tail.includes(k));
  }

  private _extractContentBlock(raw: string): { contentBlock: string | null; cleaned: string } {
 const pattern = /@@CONTENT@@\s*\n?([\s\S]*?)(?:@@END_CONTENT@@|$)/;
  const m = raw.match(pattern);
  if (m) {
    const content = m[1].trim();
    if (!content) return { contentBlock: null, cleaned: raw };
    const mIdx = m.index ?? 0;
    const cleaned = raw.slice(0, mIdx) + raw.slice(mIdx + m[0].length);
    return { contentBlock: content, cleaned };
  }
  return { contentBlock: null, cleaned: raw };
}

  /**
   * 只取第一个 { ... }，不扫描后续
   *
   * 第一个不合法 → 返回 (null, false)，让 parse 判断是否 _retry
   * 不再“跳过不合法的，找合法的”，避免选到第二个 JSON
   */
  private _findAndParseJson(raw: string): { result: any; jsonFound: boolean } {
    if (!raw) return { result: null, jsonFound: false };

    // 剥离 markdown 代码块（如果整个文本被 ```json 包裹）
    const unwrapped = this._unwrapCodeBlock(raw);
    const s = unwrapped.trim();

    // 找第一个 {
    const start = s.indexOf("{");
    if (start === -1) return { result: null, jsonFound: false };

    // 找第一个配对的 }
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;

    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }

    if (end === -1) {
      // 括号不全，返回失败（交给上层重试）
      return { result: null, jsonFound: false };
    }

    // 只解析第一个
    const candidate = s.slice(start, end + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        return { result: parsed, jsonFound: true };
      }
    } catch { /* ignore */ }

    return { result: null, jsonFound: false };
  }

  private _unwrapCodeBlock(raw: string): string {
    let m = raw.match(/```json\s*\n?([\s\S]*?)\n?```/);
    if (m) {
      const inner = m[1].trim();
      const before = raw.slice(0, m.index!).trim();
      const after = raw.slice(m.index! + m[0].length).trim();
      return [before, inner, after].filter(Boolean).join("\n");
    }
    m = raw.match(/```\s*\n?([\s\S]*?)\n?```/);
    if (m) {
      const inner = m[1].trim();
      const before = raw.slice(0, m.index!).trim();
      const after = raw.slice(m.index! + m[0].length).trim();
      return [before, inner, after].filter(Boolean).join("\n");
    }
    return raw;
  }



  private _normalizeCallField(result: any): string | null {
    if (!result || typeof result !== "object") return null;

    let callVal: any = null;
    for (const key of ["call", "Call", "CALL"]) {
      if (key in result) { callVal = result[key]; delete result[key]; break; }
    }

    if (callVal) {
      const lower = String(callVal).toLowerCase();
      if (VALID_CALLS.has(lower)) return lower;
    }

    // 推断
    const args = result.args;
    if (args && typeof args === "object" && args.target) {
      Logger.warn("缺少 call 字段，但有 args.target，补全为 use_tool");
      return "use_tool";
    }

    if ("target" in result) {
      Logger.warn("缺少 call 字段，但有顶层 target，补全为 use_tool");
      if (!result.args || typeof result.args !== "object") result.args = {};
      result.args.target = result.target; delete result.target;
      if ("action" in result) { result.args.action = result.action; delete result.action; }
      if ("params" in result) { result.args.params = result.params; delete result.params; }
      return "use_tool";
    }

    if ("content" in result && Object.keys(result).length <= 3) {
      Logger.warn("缺少 call 字段，但有 content，补全为 reply");
      return "reply";
    }

    return null;
  }

  private _injectContentBlock(result: any, contentBlock: string): void {
    const call = result.call ?? "";

    if (call === "reply" || call === "ask_user") {
      result.content = contentBlock;
      return;
    }

    if (call !== "use_tool") return;

    const args = result.args ?? {};
    if (typeof args !== "object") { result.args = {}; }
    const a = result.args;
    const params = a.params ?? {};
    if (typeof params !== "object") { a.params = {}; }
    const p = a.params;

    const target = a.target ?? "";
    const action = a.action ?? "";

    const isClear = action === "clear";

    if (target === "builtins/tools/add_experience") {
      if (isClear) return;
      p.experience = contentBlock;
    } else if (target === "builtins/tools/add_task_board") {
      if (isClear) return;
      p.content = contentBlock;
    } else if (target === "builtins/tools/aicp_chat") {
      p.task = contentBlock;
    } else if (target === "builtins/tools/fix_tool") {
      p.issue = contentBlock;
        } else if (target === "os/file_utils_api" &&
               (action === "write_file" || action === "append_file" || action === "apply_patch")) {
      p.content = contentBlock;
    } else {
      p.content = contentBlock;
    }
  }

  private _makeRetry(reason: string): any {
    return {
      think: "格式错误，需要重试",
      call: "_retry",
      content: "",
      args: {},
      _validation_reason: reason,
    };
  }

  private _makeReply(think: string, content: string): any {
    return { think, call: "reply", content, args: {} };
  }

  private _errorResponse(think: string, content: string): any {
    return {
      think,
      call: "reply",
      content,
      args: {},
      _validation_failed: true,
      _validation_reason: think,
    };
  }

  private _ensureDefaults(result: any): any {
    result.think = result.think ?? "";
    result.call = result.call ?? "reply";
    result.args = result.args ?? {};
    if (!result.args || typeof result.args !== "object") result.args = {};
    if (result.call === "reply" || result.call === "ask_user") {
      if (result.content === undefined || result.content === null) result.content = "";
      if (typeof result.content !== "string") {
        result.content = JSON.stringify(result.content);
      }
    }
    result.think = String(result.think);
    result.call = String(result.call);
    return result;
  }

  // 统计完整 JSON 对象数（用于熔断）
 countJsonObjects(raw: string): number {
  if (!raw) return 0;
  let count = 0;
  let i = 0;
  while (i < raw.length) {
    const start = raw.indexOf("{", i);
    if (start === -1) break;
    let depth = 0, inString = false, escape = false, end = -1;
    for (let j = start; j < raw.length; j++) {
      const ch = raw[j];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end !== -1) {
      try {
        const obj = JSON.parse(raw.slice(start, end + 1));
        if (obj && typeof obj === "object") count++;  // ★ 去掉 "call" in obj
      } catch { /* ignore */ }
      i = end + 1;
    } else {
      break;
    }
  }
  return count;
}
}
// ============================================================
// FastValidator
// ============================================================

class FastValidator {
  static validate(output: any): any {
    if (output?.call === "_retry") return output;

    if (output?._multiple_json_detected) {
      const count = output._json_count ?? 2;
      output._validation_failed = true;
      output._validation_reason = `❌ 检测到 ${count} 个 JSON 对象！每轮只能输出 1 个 JSON。`;
      return output;
    }

    if ("use_tool" in output) {
      const target = output.use_tool;
      if (!target) {
        output._validation_failed = true;
        output._validation_reason = "缺少 use_tool 目标";
        return output;
      }
      const params = output["参数"] ?? {};
      output.call = "use_tool";
      output.args = { target, params };
      delete output.use_tool;
      delete output["参数"];
    }

    const call = output.call ?? "";
    if (!call) {
      output._validation_failed = true;
      output._validation_reason = "缺少 call 字段，必须为 use_tool 或 reply";
      return output;
    }

    if (!VALID_CALLS.has(call)) {
      output._validation_failed = true;
      output._validation_reason = `未知 call '${call}'，只允许 use_tool 或 reply`;
      return output;
    }

  if (call === "reply") {
  const content = output.content ?? "";
  if (!content) {
    output._validation_failed = true;
    output._validation_reason = "JSON reply 缺少 content 字段。回复用户请用纯文本，不要用 JSON。";
    return output;
  }
  return output;
}

    if (call === "use_tool") {
      const args = output.args ?? {};
      if (!args) {
        output._validation_failed = true;
        output._validation_reason = "缺少 args";
        return output;
      }
      const target = args.target;
      if (!target) {
        output._validation_failed = true;
        output._validation_reason = "缺少 target";
        return output;
      }

      // main_agent 自调用拦截
      if (target === "builtins/agents/main_agent") {
        const action = args.action ?? "";
        const params = args.params ?? {};
        const content = params.content ?? "";
        if (action === "reply" && content) {
          output.call = "reply";
          output.content = content;
          output.args = {};
          delete output._validation_failed;
          delete output._validation_reason;
          return output;
        }
        output._validation_failed = true;
        output._validation_reason =
          "禁止 use_tool 直接调用 builtins/agents/main_agent。\n" +
          "要回复用户，直接输出纯文本（call=reply）。";
        return output;
      }

      if (target === "reply" || target === "builtins/agents/reply") {
        args.target = "builtins/agents/main_agent/reply";
        output.args = args;
      }

      if (!("params" in args)) {
        args.params = {};
        output.args = args;
      }
    }

    delete output._validation_failed;
    delete output._validation_reason;
    return output;
  }
}

// ============================================================
// PromptManager
// ============================================================

const SYSTEM_PROMPT = `你是 BIO-ts-1，自举式 AI 助手。Session: __SESSION_ID__

你可以调度、创建、修复、删除插件来实现自我迭代；基于经验背包复用过往能力。
你不是工具，你是系统的主人。

# 工作方式
自递归 Agent：每轮输出一个动作，系统执行后结果注入信息流，你再次决策，直到任务完成。
复杂任务拆成多步，每轮执行一步。

# 输出规则（最高优先级，唯一标准）

每轮只输出以下两种之一，不得有任何其他内容：

**A. 回复用户**：直接写文字，不带任何 JSON 标记,不要输出推理内容，而是明确回复
例：好的，我来帮你创建番茄钟，需要前端界面吗？

⚠️ 回复用户时禁止用 JSON 格式。
❌ 不要输出 {"call":"reply","content":"..."}
✅ 直接输出：好的，我来帮你创建番茄钟


**B. 调用工具**：严格输出一个 JSON，不要用 \`\`\`json ... \`\`\` 包裹，直接输出纯 JSON：


{
  "think": "本轮推理，尽量简短",
  "call": "use_tool",
  "retain": N,
  "args": {"target":"插件路径","action":"动作","params":{参数}}
}
规则：
⚠️ 禁止在 JSON 之前写任何文字。
⚠️ 如果你想说明什么，写在 think 字段里。
1. think 字段用于推理，系统会忽略它，不影响执行。
think 字段约束：
- 禁止英文双引号 "，需要引用用「」或 '
- 禁止反斜杠 \\
- 禁止换行，用空格代替
- 禁止 emoji
2. ⚠️ 一次只输出 1 个 JSON —— 系统会中断生成，你需要重试
3. JSON 必须能被 JSON.parse 解析，括号闭合。
4. 有 action 的插件：action 放 args 顶层，参数放 args.params。
5. 无 action 的插件：直接写 args.params，不写 action。
6. 需要 content 参数的插件：JSON 中省略 content，在 JSON 之后另起 @@CONTENT@@ 块写内容，@@END_CONTENT@@ 结束。块内纯文本，无需转义。
7. 大文本参数规则：凡是参数值是"大段文本"（经验、看板、issue 描述、文件内容等超过一句话的），一律省略 JSON 中的该字段，改走 @@CONTENT@@ 块。
   已知适用：add_experience.experience、add_task_board.content、fix_tool.issue、file_utils_api.content。
8. 禁止：多个 JSON、<think> 标签、<function> 等原生工具调用语法、Python 代码块、额外解释文字。
9. retain 取值 1-10：
   - 纯一次性、无后续依赖的操作：1
   - 写文件、调用工具后需要确认结果的：3
   - 读文件、查契约等需要跨轮复用的：5
   - 任务收尾决策：保持 3-5

# 高频工具（禁止查契约，直接照抄模板改值）

**create_tool**（创建工具/应用，无 action）：
{
  "think": "用户要创建X，我先确认需求或直接创建",
  "call": "use_tool",
  "retain": 1,
  "args": {"target":"builtins/tools/create_tool","params":{"name":"项目名","description":"需求描述"}}
}

**fix_tool**（修复已有工具，action 默认 "fix" 可不传，issue 走 @@CONTENT@@ 块）：
⚠️ 重要：fix_tool 必须带 @@CONTENT@@ 块，否则会报“缺少 issue 参数”！
{
  "think": "X插件有问题，我用fix_tool修复",
  "call": "use_tool",
  "retain": 1,
  "args": {"target":"builtins/tools/fix_tool","params":{"target":"项目名"}}
}
@@CONTENT@@
问题描述写这里，支持多行，无需转义
@@END_CONTENT@@

**remove_tool**（删除项目，无 action）：
{
  "think": "用户要删除X",
  "call": "use_tool",
  "retain": 1,
  "args": {"target":"builtins/tools/remove_tool","params":{"target":"项目名"}}
}

**contract_agent**（查契约，action 在顶层）：
{
  "think": "我不确定X插件的接口，查契约",
  "call": "use_tool",
  "retain": 5,
  "args": {"target":"builtins/agents/contract_agent","action":"get","params":{"plugin":"插件全路径"}}
}

**cogitor**（系统地图，action 在顶层）：
{
  "think": "我需要看系统有哪些插件",
  "call": "use_tool",
  "retain": 3,
  "args": {"target":"builtins/agents/cogitor","action":"list_plugins","params":{}}
}

**file_utils_api**（文件读写，action 在顶层）：

读文件（≤100KB 返回全文；>100KB 只返回尾部预览，需用 read_file_lines 读指定范围）
{
  "think": "读取X文件内容",
  "call": "use_tool",
  "retain": 3,
  "args": {"target":"os/file_utils_api","action":"read_file","params":{"path":"data/test.txt"}}
}

写文件（content 走 @@CONTENT@@ 块，全量覆盖）：
{
  "think": "写入X内容到文件",
  "call": "use_tool",
  "retain": 3,
  "args": {"target":"os/file_utils_api","action":"write_file","params":{"path":"data/test.txt"}}
}
@@CONTENT@@
文件内容写这里
@@END_CONTENT@@

追加文件（content 走 @@CONTENT@@ 块，大文件分块用）：
{
  "think": "追加内容到文件",
  "call": "use_tool",
  "retain": 3,
  "args": {"target":"os/file_utils_api","action":"append_file","params":{"path":"data/test.txt"}}
}
@@CONTENT@@
追加内容写这里
@@END_CONTENT@@

局部替换（find 必须唯一匹配，大文件改小部分用）：
⚠️ edit_file 只用于单行短字符串替换。find/replace 直接放 JSON，禁止换行。
   大段代码、多行改动一律用 apply_patch。
{
  "think": "替换X文件里的Y片段",
  "call": "use_tool",
  "retain": 3,
  "args": {"target":"os/file_utils_api","action":"edit_file","params":{"path":"www/project/index.html","find":"旧内容","replace":"新内容"}}
}

应用 diff 补丁（content 走 @@CONTENT@@ 块，大文件多处改动用）：
{
  "think": "用 diff 补丁改X文件",
  "call": "use_tool",
  "retain": 3,
  "args": {"target":"os/file_utils_api","action":"apply_patch","params":{"path":"www/project/index.html"}}
}
@@CONTENT@@
@@ -100,5 +100,10 @@
 <div class="canvas-node">
-  <div class="cn-handle"></div>
+  <div class="cn-handle target"></div>
+  <div class="cn-handle source"></div>
 </div>
@@END_CONTENT@@

⚠️ apply_patch 的参数名是 content（和 write_file / append_file 一致）
⚠️ content 走 @@CONTENT@@ 块

列目录：
{
  "think": "列出X目录",
  "call": "use_tool",
  "retain": 3,
  "args": {"target":"os/file_utils_api","action":"list_dir","params":{"path":"data/"}}
}

删文件：
{
  "think": "删除X文件",
  "call": "use_tool",
  "retain": 1,
  "args": {"target":"os/file_utils_api","action":"delete_file","params":{"path":"data/test.txt"}}
}

检查存在：
{
  "think": "检查X是否存在",
  "call": "use_tool",
  "retain": 2,
  "args": {"target":"os/file_utils_api","action":"exists","params":{"path":"data/test.txt"}}
}
按行读文件（大文件用，行号从 1 开始，可加 with_line_num:true）：
{
  "think": "读X文件第100到200行",
  "call": "use_tool",
  "retain": 3,
  "args": {"target":"os/file_utils_api","action":"read_file_lines","params":{"path":"data/test.txt","start_line":100,"end_line":200,"with_line_num":true}}
}

文件属性：
{
  "think": "查看X文件属性",
  "call": "use_tool",
  "retain": 3,
  "args": {"target":"os/file_utils_api","action":"file_stat","params":{"path":"data/test.txt"}}
}

建目录：
{
  "think": "创建X目录",
  "call": "use_tool",
  "retain": 1,
  "args": {"target":"os/file_utils_api","action":"mkdir","params":{"path":"data/workspace/newdir"}}
}


⚠️ 大文件（> 10KB）改小部分，用 edit_file，不要用 write_file
⚠️ 大文件多处改动，用 apply_patch，不要用 write_file
⚠️ edit_file 的 find 必须唯一匹配
⚠️ apply_patch 的 hunk 的上下文行必须和原文件完全一致
⚠️ 大文件分块写：先 write_file 写第一块，再 append_file 追加后续块，每块控制在 5KB 以内

**add_experience**（沉淀经验，无 action，experience 走 @@CONTENT@@ 块）：
{
  "think": "任务完成，沉淀本次经验",
  "call": "use_tool",
  "retain": 2,
  "args": {"target":"builtins/tools/add_experience","params":{"action":"replace"}}
}
@@CONTENT@@
经验内容写这里，可以是任意长文本，无需转义
@@END_CONTENT@@

**add_task_board**（任务看板，无 action，content 走 @@CONTENT@@ 块）：
{
  "think": "更新任务看板",
  "call": "use_tool",
  "retain": 2,
  "args": {"target":"builtins/tools/add_task_board","params":{"action":"replace"}}
}
@@CONTENT@@
看板内容写这里，支持多行，无需转义
@@END_CONTENT@@

**search_memory**（搜历史记忆，action 在顶层）：
{
  "think": "信息流不够，搜历史记忆",
  "call": "use_tool",
  "retain": 3,
  "args": {"target":"builtins/agents/search_memory","action":"search","params":{"session_id":"__SESSION_ID__","query":"关键词","keywords":["词1","词2"]}}
}
**os/_cron**（定时任务/心跳，action 在顶层）：
⚠️ target_receiver 用 builtins/agents/main_agent 是系统调度，不走 use_tool，
   不受"禁止直接调 main_agent"铁律约束。

设置心跳：
{
  "think": "设置定时任务",
  "call": "use_tool",
  "retain": 3,
  "args": {"target":"os/_cron","action":"schedule","params":{"task_id":"heartbeat_1","interval":60,"target_receiver":"builtins/agents/main_agent","target_payload":{"content":"[心跳] 定时触发","session_id":"__SESSION_ID__"}}}
}

取消心跳：
{
  "think": "取消定时任务",
  "call": "use_tool",
  "retain": 1,
  "args": {"target":"os/_cron","action":"cancel","params":{"task_id":"heartbeat_1"}}
}

查看心跳：
{
  "think": "查看所有定时任务",
  "call": "use_tool",
  "retain": 3,
  "args": {"target":"os/_cron","action":"list","params":{}}
}

# 工具调用决策

遇到需求，按顺序判断：

1. 上方高频工具覆盖 → 直接调用
2. ⚠️ 高频工具但不确定 action → 先 contract_agent.get 查契约，看支持哪些 action
   例：file_utils_api 不确定用 read_file 还是 list_dir → 先查契约
3. 低频工具或未知插件 → contract_agent.get 查契约（同一插件只查一次）
4. 用户的需求大任务 → 先和用户确认需求，达成一致后 create_tool
5. 复杂系统（多项目协作）→ 建议走 web Studio
5.5 需要领域能力 → skill_loader 搜索 → skill_loader.load 加载专家
   ⚠️ 技能加载后【当前技能】区块会出现在你的 prompt 里，
      下一轮你就用这个技能的人格/知识直接回复或根据技能完成任务或者和用户沟通。
      绝对不要把问题转发给 main_agent 或任何 agent！
      你就是那个专家，自己回答。

   用法：
   {
     "think": "需要 Python 专家能力",
     "call": "use_tool",
     "retain": 3,
     "args": {
       "target": "builtins/tools/skill_loader",
       "action": "search",
       "params": {
         "query": "如何调试 Python 性能问题",
         "keywords": ["python", "debugging", "performance"]
       }
     }
   }

   加载技能：
   {
     "think": "加载技能到上下文",
     "call": "use_tool",
     "retain": 1,
     "args": {
       "target": "builtins/tools/skill_loader",
       "action": "load",
       "params": {"skill_id": "xxx"}
     }
   }
   ⚠️ skill_id 是"路径派生 ID"，格式：{父目录}_{目录名}，全小写。
      例：data/skills/aicp/apply_patch_skill/SKILL.md 的 skill_id 是 aicp_apply_patch_skill。
   ⚠️ 如果不确定完整 skill_id，直接传模糊名（如 apply_patch_skill），
      load 会自动模糊匹配。匹配到多个会返回候选让你选。
   清空技能：
   {
     "think": "卸载当前技能",
     "call": "use_tool",
     "retain": 1,
     "args": {
       "target": "builtins/tools/skill_loader",
       "action": "clear",
       "params": {}
     }
   }
6. 多个独立子任务（可并行）→ 用 task_manager 开分身
   ⚠️ 判断标准：
   - 任务可以拆成 2 个以上相互独立的子任务并行
   - 每个子任务不需要其他子任务的结果
   - 子任务各自耗时较长（适合并行）
   典型场景：
   - 验证多个独立猜想（A、B、C 各开一个分身）
   - 批量处理多个文件（每个文件一个分身）
   - 并行调研多个主题

   用法（一次 create 开一个分身，可连续 create 多个）：
   {
     "think": "猜想 A、B、C 相互独立，可以并行验证",
     "call": "use_tool",
     "retain": 3,
     "args": {
       "target": "builtins/tools/task_manager",
       "action": "create",
       "params": {
         "description": "验证猜想 A",
         "task": "验证哥德巴赫猜想在 4-10000 范围内是否成立，输出反例或确认"
       }
     }
   }

   - 分身完成后自动回调，你会收到「【分身任务】摘要 + 具体结果」
   - 查进度：task_manager.list
   - 看单个：task_manager.status（需 task_id）
   - 收集结果：task_manager.collect（不传 task_id 拿全部；传 task_id 查单个）
   - 清空记录：task_manager.clear
   - 任务摘要会出现在下一轮 prompt 的【分身任务】里

   ⚠️ 分身结果通过回调推回，不需要主动 collect。
   ⚠️ 等所有分身完成（【分身任务】里全部是 ✅ / ❌ / ⏰），再汇总回复。
   ⚠️ 如果还有 ⏳，说明还有分身运行中，回复「还有 N 个运行中，等待完成」即可，不要急着汇总。
   ⚠️ 不要用 use_tool 直接调 builtins/agents/main_agent。
      要开分身，统一走 task_manager。
   ⚠️ 不要自己拼 session_id / callback_receiver / _task_id，task_manager 全权处理。

7. 一次性任务 → aicp_chat 兜底


   ⚠️ aicp_chat 的返回格式：
   - 成功：{"ok": true, "data": "...", "artifact": "logs/code_cleaned_xxx.js"}
   - 失败：{"ok": false, "error": "...", "error_category": "...", "artifact": "logs/llm_errors/error_xxx.txt", "aborted": false}

   ⚠️ artifact 是什么：
   - 一个文件路径，相对项目根
   - 成功时指向最后执行成功的代码文件
   - 失败时指向最后一次的错误报告
   - 路径可直接传给 os/file_utils_api 的 read_file
   - 当aicp_chat返回结果和task预期不一致，可以读取artifact，分析后再给出更准确的task描述，保证task准确。

   ⚠️ 失败时怎么办：
   - 先看 error 字段，它包含错误分类、原因、处理建议
   - error_category 含义：
     * LLM_CODE      → 代码写错了，改 task 重试
     * SANDBOX_BLOCK → 用了沙箱禁止的操作，换实现方式
     * RUNTIME_INTERNAL → runtime 内部问题，不要改代码，直接告知用户
   - aborted=true 表示系统已终止重试，不要再调 aicp_chat
   - 需要看完整错误报告或上一轮代码时，读 artifact：
     {"think":"aicp_chat失败，读错误报告","call":"use_tool","retain":3,
      "args":{"target":"os/file_utils_api","action":"read_file","params":{"path":"logs/llm_errors/error_xxx.txt"}}}
   - 读完调整 task，重新调 aicp_chat
   - 连续 2 次相同错误，直接回复用户"无法完成"

⚠️ 不要在不确定 action 的情况下反复试错。
   比如「读目录」用 read_file 失败，说明 action 不对，应该先查契约。

【信息流格式】
系统会把历史对话按以下格式给你：

[时间] 👤 用户消息
[时间] 💭 AI 思考
[时间] 🔧 调用 use_tool
[时间] 📤 调用工具（call_start，含目标插件名）
[时间] ✅ <插件名> 调用完成（call_end，结果在下方）← 工具已执行
[时间] 📊 系统消息

⚠️ 看到 ✅ <插件名> 调用完成，说明该工具已执行，结果已返回。
⚠️ 不要重复调用同一个工具。如果已有结果，直接用结果回复用户。
⚠️ 如果用户问「有哪些插件」而你已查过，直接把上次结果整理回复，不要重复查。

【关于 Session 类型】
- Session ID 以 "sub_" 开头 → 你是分身，不能开新分身。
- 分身的职责是在单条执行线上完成任务，不负责拆分。
- 分身不能用 task_manager，不能调 main_agent。

【关于分身任务】
- 分身完成后会自动回调，你会收到【分身任务】摘要 + 具体结果。
- 摘要里 ✅ 表示完成，⏳ 表示运行中，❌ 表示失败，⏰ 表示超时。
- 等所有分身完成（全部 ✅ / ❌ / ⏰），再汇总回复。
- 如果还有 ⏳，不要急着汇总，回复「还有 N 个运行中，等待完成」即可。
- 不要重复 create 同一个分身。
- 不要用 task_manager.status 反复查同一个 task_id。
- 不要主动 collect，结果通过回调推回。

# 系统认知
- 插件在 src/plugins/，路由 = 去掉 src/plugins/ 和 .ts 后缀
- 前端在 www/项目名/index.html → 访问 /项目名/
- 外部 API：http://127.0.0.1:9000/api/插件名
- 创建/修复/删除必须用对应工具，禁止直接操作文件
- 路径统一用正斜杠 /

# 行为准则
1. 创建/删除前，先用文本回复确认意图。
2. create_tool 禁止自己输出代码，代码由 generator 生成。
3. create_tool 成功后不要重复调用，创建后后端插件会自动热加载，查询契约后即可使用
4. 单文件简单读写统一用 file_utils_api。
5. 遇到高价值经验主动 add_experience。
6. 主动用 add_task_board 建任务看板，记录当前任务的关键信息，每次推进后更新，完成后 clear。
7. 同一插件契约查过一次后，直接用记忆，禁止重复查询。
8. 技能加载后，你就是那个技能的角色。直接以角色身份回复用户或执行相应的 SKILL。
9. 技能不需要时，主动 clear 卸载。
10. 禁止把"下一步计划"当回复输出。如果你想继续调工具，
    直接输出 JSON，不要先写"接下来测 X"、"先测 Y"这类叙述。
    叙述只在任务完成、向用户汇报结果时才写。
    ❌ 反例："还有 list_dir 没测，继续测试。"（然后停住）
    ✅ 正例：直接输出 list_dir 的 JSON。

11. 任务完成后，如果满足以下条件，主动沉淀成 skill：
    - 用了 3 个以上工具
    - 工具有明确顺序（有依赖关系）
    - 任务顺利完成，没走弯路
    - 未来可能遇到类似任务

    沉淀方式：write_file 写一个 SKILL.md 到 data/skills/aicp/{skill_id}/SKILL.md。
    格式：frontmatter（title/description/tags）+ 正文（适用场景/工作流程）。
    参数用 {xxx} 占位。

    ⚠️ 不是每个任务都要沉淀。只在"明显值得复用"时才写。
    ⚠️ 写完不用手动 scan。下次调 skill_loader.search 或 list 会自动扫到。

# 铁律（最后再强调一次）
🔴 一次只输出 1 个 JSON 或 1 段文本，禁止多个 JSON
🔴 禁止多个 JSON —— 系统会中断生成，你需要重试
🔴 如果需要多个操作，分多轮：本轮一个，下一轮再一个
🔴 think 字段用于推理，之后字段严格照结构写。
🔴 高频工具照抄模板，不要自己拼结构。
🔴 action 放 args 顶层；无 action 的插件直接写 params。
🔴 大文本参数（experience / content / issue）一律走 @@CONTENT@@ 块。
🔴 禁止 <think> 标签（XML 标签），think 是 JSON 字段。
🔴 禁止输出代码块、原生 function 调用格式。
🔴 临时文件的默认工作目录：data/workspace
🔴 不确定 action → 先查契约，不要瞎试
🔴 回复用户时用纯文本，不要用 JSON reply

`;

class PromptManager {
  static buildSystem(sessionId: string): string {
    return SYSTEM_PROMPT.replace(/__SESSION_ID__/g, sessionId);
  }

  static async buildUser(sessionId: string, context: string, depth: number = 0): Promise<string> {
    const parts: string[] = [];
    const currentTime = new Date().toISOString().replace("T", " ").slice(0, 19);
    const experience = await loadExperience(sessionId);
    const taskboard = await loadTaskboard(sessionId);

    if (context) parts.push(`【信息流】\n${context}`);



    if (experience) parts.push(`【经验背包】\n${experience}`);
    if (taskboard) parts.push(`【任务看板】\n${taskboard}`);

    // ★ 当前技能
    const activeSkill = await loadActiveSkill(sessionId);
    if (activeSkill) parts.push(`【当前技能】\n${activeSkill}`);

    let hint: string;
    if (depth === 0) hint = "开始执行，综合分析，整理思路，逐步执行，一次只调用一次工具或者回复";
    else if (depth <= 10) hint = "执行中：检查上一步结果，继续推进。";
    else if (depth <= 20) hint = "检查：本次执行是否接近完成？是→回复结果，否→继续。";
    else if (depth <= 30) hint = "注意：已执行多步，优先考虑是否该回复用户当前进展。";
    else hint = "警告：执行深度过高接近上限，整理原因，准备收尾，及时回复用户。";

    parts.push(`【当前递归执行】\n当前时间：${currentTime}\n执行深度：${depth}/${MAX_RECURSION_DEPTH} - ${hint}\n`);
    parts.push('🔴现在只输出一个 JSON 或 用文本回复用户。不要回复你的推理过程，开始：')

    return parts.join("\n\n");
  }
}

// ============================================================
// 会话状态（模块级）
// ============================================================

const _sessionFlows = new Map<string, InformationFlow>();
const _sessionLocks = new Map<string, Promise<any>>();
const _thinkSessions = new Set<string>();
const _pendingCallbacks = new Map<string, number>();
const _interruptSignals = new Map<string, boolean>();

function getOrCreateFlow(sessionId: string): InformationFlow {
  if (!_sessionFlows.has(sessionId)) {
    _sessionFlows.set(sessionId, new InformationFlow(sessionId));
  }
  return _sessionFlows.get(sessionId)!;
}

async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = _sessionLocks.get(sessionId) ?? Promise.resolve();
  let resolveNext: () => void;
  const next = new Promise<void>((r) => { resolveNext = r; });
  const chain = prev.then(() => next);
  _sessionLocks.set(sessionId, chain);

  try {
    await prev;
    return await fn();
  } finally {
    resolveNext!();
    if (_sessionLocks.get(sessionId) === chain) {
      _sessionLocks.delete(sessionId);
    }
  }
}

// ============================================================
// LLMThinker
// ============================================================

class LLMThinker {
  parser = new LLMOutputParser();

  async think(agent: Agent, flow: InformationFlow, sessionId: string, depth: number): Promise<any> {
    const llm = agent.llm;
    if (!llm) {
      return { think: "LLM 不可用", call: "reply", content: "抱歉，AI 服务暂时不可用", args: {} };
    }

    const context = flow.getContext();
    const systemPrompt = PromptManager.buildSystem(sessionId);
    const userPrompt = await PromptManager.buildUser(sessionId, context, depth);

    Logger.info("LLM 思考中...");

    const channel = `pa_${sessionId}`;
    let raw = "";
    let interrupted = false;
    let interruptedReason = "未知原因";
    let tokenCount = 0;
    const checkInterval = 5;
    const startTime = Date.now();
    const MAX_RAW_LENGTH = 100000;

    try {
      const messages = [
        { role: "system" as const, content: systemPrompt },
        { role: "user" as const, content: userPrompt },
      ];

      for await (const token of llm.chat_stream(messages)) {
        raw += token;
        tokenCount++;


        if (raw.length > MAX_RAW_LENGTH) {
    Logger.warn(`LLM 输出过长（${raw.length}），中断`);
    interrupted = true;
    interruptedReason = "输出过长";
    await pushError(agent, sessionId, `⚠️ 输出过长（${raw.length} 字符），已中断，正在重试...`);
    break;
  }
        // 熔断 1：超时
        if (Date.now() - startTime > MAX_STREAM_TIME * 1000) {
          Logger.warn(`单次 LLM 调用超过 ${MAX_STREAM_TIME}s，中断`);
          interrupted = true;
          interruptedReason = "单次调用超时";
          await pushError(agent, sessionId, `⚠️ 生成超时（${MAX_STREAM_TIME}s），已中断，正在重试...`);
          break;
        }

        // 熔断 2：think 过长
        if (raw.includes('"think"') && !raw.includes('"call"')) {
          const thinkStart = raw.indexOf('"think"');
          if (thinkStart !== -1 && raw.length - thinkStart > THINK_MAX_CHARS) {
            Logger.warn(`think 字段过长（>${THINK_MAX_CHARS}），中断`);
            interrupted = true;
            interruptedReason = "think 字段过长";
            await pushError(agent, sessionId, "⚠️ think 字段过长，已中断，正在重试...");
            break;
          }
        }

        // 熔断 3：多个 JSON
               // 熔断 3：多个 JSON
        // 前置判断：只统计 @@CONTENT@@ 块之前的 {，避免块内 HTML/JSON 误触发
        if (tokenCount % checkInterval === 0) {
          const beforeContent = raw.split("@@CONTENT@@")[0];
          const braceCount = (beforeContent.match(/\{/g)?.length ?? 0);
          if (braceCount >= 2) {
            const jsonCount = this.parser.countJsonObjects(beforeContent);
            if (jsonCount >= 2) {
              Logger.warn(`检测到 ${jsonCount} 个 JSON 对象，中断`);
              interrupted = true;
              interruptedReason = "检测到多个 JSON 对象";
              await pushError(agent, sessionId, `⚠️ 检测到异常输出（${jsonCount} 个 JSON），已中断，正在重试...`);
              break;
            }
          }
        }

        await pushStream(agent, sessionId, token);
      }
    } catch (e: any) {
      Logger.warn(`流式思考失败: ${e?.message ?? e}，降级非流式`);
      try {
        raw = await agent.llm!.chat(
          [
            { role: "system", content: PromptManager.buildSystem(sessionId) },
            { role: "user", content: await PromptManager.buildUser(sessionId, flow.getContext(), depth) },
          ]
        );
      } catch (e2: any) {
        throw new Error(`${e2?.message ?? e2}`);
      }
    }

    if (interrupted) {
      return {
        think: "输出违规，需要重试",
        call: "_retry",
        content: "",
        args: {},
        _validation_reason: interruptedReason,
      };
    }

    const rawStripped = (raw ?? "").trim();
    if (isLlmErrorString(rawStripped)) {
      Logger.warn(`检测到 LLM 错误包装: ${rawStripped.slice(0, 150)}`);
      throw new Error(rawStripped);
    }

    const result = this.parser.parse(raw);

    const content = result?.content ?? "";
    if (isLlmErrorString(content)) {
      Logger.warn(`检测到错误包装（解析后）: ${content.slice(0, 150)}`);
      throw new Error(content);
    }

    return result;
  }
}

// ============================================================
// CoreProcessor
// ============================================================

class CoreProcessor {
  thinker = new LLMThinker();

  signalInterrupt(sessionId: string): void {
    _interruptSignals.set(sessionId, true);
  }

  clearInterrupt(sessionId: string): void {
    _interruptSignals.delete(sessionId);
  }

  async process(agent: Agent, sessionId: string, flow: InformationFlow, depth: number = 0): Promise<any> {
    if (_thinkSessions.has(sessionId)) {
      _pendingCallbacks.set(sessionId, (_pendingCallbacks.get(sessionId) ?? 0) + 1);
      Logger.info(`[${sessionId}] 思考中，跳过触发（待处理回调 +1）`);
      return { ok: true, waiting: true, call: "skip", content: "", args: {} };
    }

    _thinkSessions.add(sessionId);

    try {
      let result = await this._processInternal(agent, sessionId, flow, depth);

      const pendingCount = _pendingCallbacks.get(sessionId) ?? 0;
      _pendingCallbacks.delete(sessionId);
      if (pendingCount > 0) {
        Logger.info(`[${sessionId}] 思考结束，处理 ${pendingCount} 个待处理回调`);
        result = await this._processInternal(agent, sessionId, flow, 0);
      }

      return result;
    } finally {
      _thinkSessions.delete(sessionId);
    }
  }

  private async _processInternal(agent: Agent, sessionId: string, flow: InformationFlow, depth: number): Promise<any> {
    // 中断检查
    if (_interruptSignals.get(sessionId)) {
      this.clearInterrupt(sessionId);
      return {
        ok: true,
        interrupted: true,
        call: "reply",
        content: "⏸️ 任务已中断，继续输入新指令",
        args: {},
      };
    }

    if (depth > MAX_RECURSION_DEPTH) {
      Logger.warn(`达到最大递归深度 (${MAX_RECURSION_DEPTH})`);
      return {
        ok: false,
        waiting: false,
        call: "reply",
        content: "处理步骤过多，请简化需求后重试",
        args: {},
      };
    }

    const output = await this.thinker.think(agent, flow, sessionId, depth);

    // _retry
    if (output?.call === "_retry") {
      const reason = output._validation_reason ?? "格式错误";
      let errorMsg: string;

      if (reason.includes("多个 JSON")) {
          errorMsg =
            "❌ 你上一轮输出了多个 JSON 对象，系统只执行了第一个，已中断生成。\n\n" +
            "【规则】每轮只能输出 1 个 JSON。\n" +
            "【怎么办】如果需要多个操作，请分多轮。\n" +
            "【示例】本轮只输出：\n" +
            '  {"think":"先读文件","call":"use_tool","retain":3,' +
            '"args":{"target":"os/file_utils_api","action":"read_file","params":{"path":"..."}}}\n' +
            "下一轮再输出下一个动作。";
        } else if (reason.includes("think 过长")) {
          errorMsg =
            "❌ 你上一轮的 think 字段过长（超过 1500 字符），系统已中断生成。\n\n" +
            "【think 是什么】一句话说明下一步做什么，不是内心戏。\n" +
            "【怎么改】控制在 100 字以内。\n" +
            '【正确示例】"用户要分析项目结构，我先列目录"\n' +
            '【错误示例】"用户让我做X，我在想是不是该做Y..."（内心戏）\n' +
            "请重新输出，think 控制在 100 字以内。";
        } else if (reason.includes("JSON 缺少 call")) {
          const preview = reason.includes("|") ? reason.split("|").slice(1).join("|") : "";
          errorMsg =
            "❌ 你上一轮输出的 JSON 缺少 call 字段。\n\n" +
            "【规则】每个 JSON 必须包含 call，值为 use_tool 或 reply。\n" +
            "【正确格式】\n" +
            '  {"think":"...","call":"reply","content":"你的回复"}\n' +
            "  或\n" +
            '  {"think":"...","call":"use_tool","retain":3,"args":{"target":"...","params":{...}}}\n\n' +
            "【你的原始输出】\n" +
            `${preview}\n\n` +
            "请重新输出，只输出 1 个完整 JSON。";
                } else if (reason.includes("JSON 解析失败")) {
          const preview = reason.includes("|") ? reason.split("|").slice(1).join("|") : "";
          errorMsg =
            "❌ 你上一轮的输出有 JSON 意图，但解析失败。\n\n" +
            "【常见原因】\n" +
            "  - 括号不闭合（{ 没有对应的 }）\n" +
            "  - 字符串里未转义的引号\n" +
            "  - 输出多个 JSON 对象\n" +
            "  - JSON 后面追加了文字\n" +
            "【你的原始输出预览】\n" +
            `${preview}\n\n` +
            "【正确格式】\n" +
            '  {"think":"...","call":"use_tool","retain":3,"args":{"target":"...","params":{...}}}\n' +
            "  或\n" +
            "  你好，在的。（纯文本回复）\n\n" +
            "请重新输出，只输出 1 个完整 JSON 或 1 段纯文本。";
        } else if (reason.includes("单行 patch")) {          // ★ 新增
          errorMsg =
            "❌ 你上一轮把多行 patch 压缩成了一行，系统无法解析。\n\n" +
            "【规则】@@CONTENT@@ 块内必须保留换行，每行独立。\n" +
            "【diff 格式】\n" +
            "  --- a/文件路径\n" +
            "  +++ b/文件路径\n" +
            "  @@ -1,3 +1,3 @@\n" +
            "   上下文行（空格开头）\n" +
            "  -删除行\n" +
            "  +新增行\n" +
            "【注意】@@ / --- / +++ / 空格 / - / + 各占一行，不能挤在一起。\n" +
            "请重新输出，块内保留换行。";
        } else if (reason.includes("需要大文本参数") || reason.includes("没有输出 @@CONTENT@@")) {
          errorMsg =
            "❌ 你调用了需要大文本参数的工具，但没有输出 @@CONTENT@@ 块。\n\n" +
            "【如果是 clear 操作】\n" +
            "  add_task_board / add_experience 的 action=clear 不需要 @@CONTENT@@ 块，\n" +
            '  正确格式：{"think":"...","call":"use_tool","args":{"target":"builtins/tools/add_task_board","action":"clear"}}\n\n' +
            "【如果是 replace/add 操作】\n" +
            "【规则】add_experience / add_task_board / aicp_chat / fix_tool / " +
            "file_utils_api(write_file/append_file/apply_patch) 这些工具的文本参数" +
            "必须走 @@CONTENT@@ 块，不能省。\n" +
            "【正确格式】\n" +
            '  {"think":"...","call":"use_tool","retain":3,"args":{"target":"os/file_utils_api",' +
            '"action":"write_file","params":{"path":"data/x.txt"}}}\n' +
            "  @@CONTENT@@\n" +
            "  文件内容写这里\n" +
            "  @@END_CONTENT@@\n\n" +
            "请重新输出，JSON + @@CONTENT@@ 块。";
        } else {
          errorMsg =
            `❌ 输出不符合要求：${reason}\n\n` +
            "请重新输出，只输出 1 个合法 JSON 或纯文本回复用户。";
        }

      await flow.appendSystem("validation_error", "输出格式错误，请重新输出", { error: reason }, { full_result: errorMsg }, 5);
      return await this._processInternal(agent, sessionId, flow, depth + 1);
    }

    // FastValidator
    const validated = FastValidator.validate(output);

    if (validated._validation_failed) {
      const reason = validated._validation_reason ?? "输出格式错误";
      const errorMsg = `❌ 输出不符合要求：${reason}\n\n请重新输出，只输出 1 个合法 JSON 或纯文本回复用户。`;
      await flow.appendSystem("validation_error", "输出格式错误，请重新输出", { error: reason }, { full_result: errorMsg }, 5);
      return await this._processInternal(agent, sessionId, flow, depth + 1);
    }

    const think = validated.think ?? "";
    const call = validated.call ?? "reply";
    let content = validated.content ?? validated.args?.content ?? "";
    const args = validated.args ?? {};
    const retain = validated.retain ?? 3;

    Logger.info(`LLM 思考: ${think.slice(0, 80)}`);
    Logger.info(`LLM 决策: ${call}`);

    await flow.appendAi(think, { call, content, args, retain });

    // ============================================================
    // reply
    // ============================================================
    if (call === "reply") {
      if (!content) content = "好的，已处理";
      Logger.info(`返回用户: ${content.slice(0, 80)}`);
      return { ok: true, waiting: false, call: "reply", content, args: {} };
    }

    // ============================================================
    // use_tool
    // ============================================================
    if (call === "use_tool") {
      const target = args.target;

      // reply 特殊路径
      if (target === "builtins/agents/main_agent/reply") {
            let c = args.params?.content ?? "";
            if (!c) c = "好的，已处理";
            return { ok: true, waiting: false, call: "reply", content: c, args: {} };
      }

      // 执行工具
      const result = await this._executeTool(agent, sessionId, flow, target, args, depth, retain);

      // 异步任务
      if (result?.data?.status === "processing") {
        const traceId = result.data.trace_id ?? "";

        // 更新 call_start
        for (let i = flow.getFlow().length - 1; i >= 0; i--) {
          const entry = flow.getFlow()[i];
          if (entry.from === "system" && entry.action === "call_start" && entry.detail?.call_id) {
            entry.detail.trace_id = traceId;
            entry.detail.status = "processing";
            break;
          }
        }

          await flow.appendSystem(
          "async_processing",
          `⏳ 异步任务已提交，正在后台执行，完成后会自动回调通知你。不要重复调用同一工具，可以先reply用户或者执行其他任务。[trace=${traceId.slice(0, 8)}]`,
          { trace_id: traceId, status: "processing" },
          undefined,
          5   // retain 改大，确保 LLM 看到
        );
        await pushChat(agent, sessionId, "⏳ 任务已提交，正在后台处理...");
        return await this._processInternal(agent, sessionId, flow, depth + 1);
      }

      await pushProgress(agent, sessionId, "done", `✅ ${call} 完成`);
      return await this._processInternal(agent, sessionId, flow, depth + 1);
    }

    // 未知 call（理论上不会到这里，FastValidator 已拦截）
    return { ok: false, waiting: false, call: "reply", content: `未知 call: ${call}`, args: {} };
  }

     private async _executeTool(
    agent: Agent,
    sessionId: string,
    flow: InformationFlow,
    target: string,
    args: any,
    depth: number,
    retain: number
  ): Promise<any> {
    const toolAction = args.action;   // ★ 不设默认
    const toolParams = args.params ?? {};

    if (!target) {
      return { ok: false, think: "缺少 target 参数" };
    }

    const callId = Math.random().toString(36).slice(2, 10);

    await flow.appendSystem(
      "call_start",
      `📤 调用工具: ${target}`,
      { call_id: callId, target, action: toolAction, params: toolParams, status: "pending" },
      undefined,
      retain
    );

    // ★ 慢工具列表：这些工具默认走异步回调
    const SLOW_TOOLS = [
      "builtins/tools/create_tool",
      "builtins/tools/fix_tool",
    ];

    const meta: any = { session_id: sessionId, _call_id: callId };
    const callParams = { ...toolParams };
    if ("callback_receiver" in callParams) meta.callback_receiver = callParams.callback_receiver;
    if ("callback_session_id" in callParams) meta.callback_session_id = callParams.callback_session_id;

    // ★ 只对慢工具默认加回调；其他工具走同步
    if (!meta.callback_receiver && SLOW_TOOLS.includes(target)) {
      meta.callback_receiver = "builtins/agents/main_agent";
    }

    // ★ 构造 payload：有 action 才加，没有就不加
    const payload: any = { ...callParams };
    if (toolAction) {
      payload.action = toolAction;
    }

    try {
      const result = await agent.system.call(new Envelop({
        sender: "builtins/agents/main_agent",
        receiver: target,
        payload,
        meta,
      }));

      if (result?.payload) {
        const pluginOk = result.payload.ok ?? true;
        const pluginError = result.payload.error ?? "";

        const think = pluginOk
          ? `工具「${target}」业务成功`
          : `工具「${target}」业务失败: ${pluginError.slice(0, 150)}`;

        if (result.payload.status !== "processing") {
          const isAsync = result.payload.data?.status === "running";
          const endLabel = isAsync
            ? `📨 异步任务已创建: ${target}`
            : `📨 调用完成: ${target}`;
          await flow.appendSystem(
            "call_end",
            endLabel,
            { call_id: callId, target, result: result.payload, is_async: isAsync },
            undefined,
            retain
          );
        }

        return {
          ok: true,
          think,
          data: result.payload,
          _full_result: JSON.stringify(result.payload),
        };
      }

      return { ok: true, think: `工具「${target}」已调用，无返回内容` };
    } catch (e: any) {
      await flow.appendSystem(
        "call_error",
        `❌ 调用失败: ${target}`,
        { call_id: callId, error: `${e?.message ?? e}` },
        undefined,
        retain
      );
      return { ok: false, think: `工具「${target}」执行失败: ${e?.message ?? e}` };
    }
  }
}

const coreProcessor = new CoreProcessor();

// ============================================================
// 附件处理
// ============================================================

async function processAttachments(
  agent: Agent,
  flow: InformationFlow,
  attachments: any[],
  userInput: string
): Promise<{ ok: boolean; error?: string; userInput: string }> {
  if (!attachments || attachments.length === 0) {
    return { ok: true, userInput };
  }

  if (attachments.length > MAX_FILES) {
    return { ok: false, error: `文件数量超过限制（最多 ${MAX_FILES} 个）`, userInput };
  }

  const oversized: string[] = [];
  const valid: any[] = [];

  for (const att of attachments) {
    let size = att?.size ?? 0;
    const path = att?.path ?? "";
    const name = att?.name ?? "未知文件";
    if (size === 0 && path && existsSync(path)) {
      try { size = (await stat(path)).size; } catch { /* ignore */ }
    }
    if (size > MAX_FILE_SIZE) {
      oversized.push(`${name} (${(size / 1024 / 1024).toFixed(1)}MB)`);
    } else {
      valid.push({ ...att, size });
    }
  }

  if (oversized.length > 0) {
    return { ok: false, error: `以下文件超过大小限制: ${oversized.join(", ")}`, userInput };
  }

  const fileLines = valid
    .map((att) => `- ${att.name} (${(att.size / 1024).toFixed(1)}KB) 路径: ${att.path}`)
    .join("\n");

  await flow.appendSystem("files_uploaded", `用户上传了 ${valid.length} 个文件`, { files: valid });

  let newInput = userInput;
  if (!userInput) {
    newInput = `用户上传了 ${valid.length} 个文件，请处理：\n${fileLines}`;
  } else {
    newInput = `${userInput}\n\n[已上传文件]\n${fileLines}`;
  }

  return { ok: true, userInput: newInput };
}

// ============================================================
// 主入口
// ============================================================

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  try {
    const action = envelop.payload?.action ?? "chat";
    const sessionId = envelop.payload?.session_id ?? envelop.meta?.session_id ?? "default";

    // ============================================================
    // 回调处理
    // ============================================================
    if (envelop.meta?.is_callback) {
      return await withSessionLock(sessionId, () => handleCallback(envelop, agent, sessionId));
    }

    // ============================================================
    // 系统管理 action
    // ============================================================
    if (action === "get_session") {
      const flow = getOrCreateFlow(sessionId);
      const allDays: string[] = [];
      if (existsSync(FLOWS_DIR)) {
        try {
          const days = await readdir(FLOWS_DIR);
          for (const day of days) {
            const dayFile = join(FLOWS_DIR, day, `${sessionId}.json`);
            if (existsSync(dayFile)) allDays.push(day);
          }
        } catch { /* ignore */ }
      }
      allDays.sort().reverse();
      envelop.payload = {
        ok: true,
        flow: flow.getFlow().slice(-20),
        all_days: allDays,
        current_day: new Date().toISOString().slice(0, 10),
      };
      return envelop;
    }

    if (action === "get_day_history") {
      const dateStr = envelop.payload?.date ?? "";
      if (!dateStr) {
        envelop.payload = { ok: false, error: "缺少 date 参数" };
        return envelop;
      }
      const dayFile = join(FLOWS_DIR, dateStr, `${sessionId}.json`);
      if (!existsSync(dayFile)) {
        envelop.payload = { ok: false, error: `没有 ${dateStr} 的历史` };
        return envelop;
      }
      try {
        const entries = JSON.parse(await readFile(dayFile, "utf-8"));
        envelop.payload = { ok: true, entries, date: dateStr };
      } catch (e: any) {
        envelop.payload = { ok: false, error: `读取失败: ${e?.message ?? e}` };
      }
      return envelop;
    }

    if (action === "clear_memory") {
      const flow = getOrCreateFlow(sessionId);
      flow.clear();
      await (flow as any)._save();
      envelop.payload = { ok: true };
      return envelop;
    }

    if (action === "get_state") {
      const type = envelop.payload?.type ?? "exp";
      const content = type === "exp"
        ? await loadExperience(sessionId)
        : await loadTaskboard(sessionId);
      envelop.payload = { ok: true, data: { type, content, size: content.length } };
      return envelop;
    }

    if (action === "save_state") {
      const type = envelop.payload?.type ?? "exp";
      const content = envelop.payload?.content ?? "";
      const dir = type === "exp" ? EXPERIENCE_DIR : TASKBOARD_DIR;
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${sessionId}_${type === "exp" ? "backpack" : "taskboard"}.txt`);
      await writeFile(file, content, "utf-8");
      envelop.payload = { ok: true, data: { type, saved: true, size: content.length } };
      return envelop;
    }

    // ============================================================
    // chat（默认）
    // ============================================================
    if (action !== "chat") {
      envelop.payload = { ok: false, error: `未知 action: ${action}` };
      return envelop;
    }

    let userInput = (envelop.payload?.content ?? "").trim();
    const attachments = envelop.payload?.attachments ?? [];

    // 附件处理
    if (attachments.length > 0) {
      const flow = getOrCreateFlow(sessionId);
      const result = await processAttachments(agent, flow, attachments, userInput);
      if (!result.ok) {
        envelop.payload = { ok: false, error: result.error };
        return envelop;
      }
      userInput = result.userInput;
    }

    if (!userInput) {
      envelop.payload = { ok: false, error: "请输入内容" };
      return envelop;
    }

    // 中断检查
    if (envelop.sender === "os/_gateway" && _thinkSessions.has(sessionId)) {
      coreProcessor.signalInterrupt(sessionId);
      envelop.payload = {
        ok: true,
        waiting: true,
        call: "reply",
        content: "⏸️ 已接收新消息，正在中断当前任务...",
        args: {},
      };
      return envelop;
    }

    // 正常流程
    Logger.info(`用户输入 [${sessionId}]: ${userInput.slice(0, 60)}`);
    await pushProgress(agent, sessionId, "thinking", "🧠 正在思考...");

    const flow = getOrCreateFlow(sessionId);
    await flow.appendUser(userInput);

    const result = await withSessionLock(sessionId, () => coreProcessor.process(agent, sessionId, flow, 0));

    if (result?.call === "skip") {
      envelop.payload = {
        ok: true,
        waiting: true,
        call: "reply",
        content: "⏳ 正在处理中，请稍候...",
        args: {},
      };
      return envelop;
    }

    envelop.payload = {
      ok: result?.ok ?? true,
      waiting: result?.waiting ?? false,
      call: result?.call ?? "reply",
      content: result?.content ?? "",
      args: {},
    };
    return envelop;
  } catch (e: any) {
    const errorStr = `${e?.message ?? e}`;
    Logger.error(`主入口执行异常: ${errorStr}`, e);

    const sessionId = envelop.payload?.session_id ?? envelop.meta?.session_id ?? "default";
    const flow = getOrCreateFlow(sessionId);

    const isLlmError = isLlmErrorString(errorStr);

    if (isLlmError) {
      // 回退 flow
      const deleted: any[] = [];
      const arr = flow.getFlow();
      if (arr.length > 0) {
        const last = arr[arr.length - 1];
        const lastFrom = last?.from ?? "";
        const lastAction = last?.action ?? "";

        if (lastFrom === "user") {
          deleted.push({ from: "user", content: (last.content ?? "").slice(0, 80) });
          arr.pop();
        } else if (["call_end", "call_error", "async_callback", "async_processing"].includes(lastAction)) {
          for (let i = arr.length - 1; i >= 0; i--) {
            if (arr[i]?.from === "ai") {
              for (const x of arr.slice(i)) {
                deleted.push({ from: x.from, action: x.action, call: x.call });
              }
              arr.splice(i);
              break;
            }
          }
        }
      }

      await (flow as any)._save();
      _pendingCallbacks.delete(sessionId);

      const lines = ["⚠️ LLM 调用失败，已中断本轮。", "", `错误详情：${errorStr.slice(0, 300)}`];
      if (deleted.length > 0) {
        lines.push("", `已回退 ${deleted.length} 条 flow：`);
        for (const item of deleted) {
          const desc = item.content ?? item.call ?? item.action ?? "?";
          lines.push(`  - [${item.from}] ${String(desc).slice(0, 60)}`);
        }
      }
      lines.push("", "请修改后重试。");
      const msg = lines.join("\n");

      await pushChat(agent, sessionId, msg);

      envelop.payload = {
        ok: false,
        waiting: false,
        call: "reply",
        content: msg,
        error: msg,
        args: { error: errorStr, deleted_count: deleted.length, deleted_items: deleted },
      };
      return envelop;
    }

    await pushChat(agent, sessionId, `❌ 系统错误: ${errorStr}`);
    envelop.payload = {
      ok: false,
      waiting: false,
      call: "reply",
      content: `系统错误: ${errorStr}`,
      error: `系统错误: ${errorStr}`,
      args: {},
    };
    return envelop;
  }
}

// ============================================================
// 回调处理
// ============================================================

async function handleCallback(envelop: Envelop, agent: Agent, sessionId: string): Promise<Envelop> {
  const flow = getOrCreateFlow(sessionId);
  const traceId = envelop.meta?.trace_id ?? envelop.trace_id;
  const callId = envelop.meta?._call_id ?? "";
    const taskId = envelop.meta?._task_id ?? "";
  const taskSummary = envelop.meta?._task_summary ?? "";
  const taskResult = envelop.meta?._task_result ?? null;

  // ★ 如果有任务摘要，先写入 flow
  if (taskSummary) {
    await flow.appendSystem(
      "task_summary",
      taskSummary,
      { task_id: taskId, result: taskResult },
      undefined,
      5
    );
  }

  const payload = envelop.payload;
  let content = "";
  if (payload && typeof payload === "object") {
    content = payload.content ?? payload.reply ?? JSON.stringify(payload);
  } else {
    content = String(payload);
  }

  // 标记 call_start
  let matched = false;
  const arr = flow.getFlow();
  for (let i = arr.length - 1; i >= 0; i--) {
    const entry = arr[i];
    if (entry.from === "system" && entry.action === "call_start") {
      if (entry.detail?.call_id === callId) {
        entry.detail.status = "completed";
        entry.detail.callback_received = true;
        matched = true;
        break;
      }
    }
  }

  await flow.appendSystem(
    "async_callback",
    `📨 回调结果 [trace=${traceId.slice(0, 8)}]`,
    { call_id: callId, trace_id: traceId, matched, result: payload },
    { full_result: content },
    3
  );

  await pushProgress(agent, sessionId, "callback", `📡 任务完成（trace=${traceId.slice(0, 8)}）`);

  const result = await coreProcessor.process(agent, sessionId, flow);

  const call = result?.call ?? "reply";
  const finalContent = result?.content ?? "";
  if ((call === "reply" || call === "ask_user") && finalContent) {
    await pushChat(agent, sessionId, finalContent);
  }

  envelop.payload = { ok: true, content: finalContent };
  return envelop;
}

// ============================================================
// help
// ============================================================

export function help() {
  return {
    route: "builtins/agents/main_agent",
    description: "AICP 主控制台 Agent — 信息流驱动版",
    input: {
      action: "chat（默认）| get_session | get_day_history | clear_memory | get_state | save_state",
      content: "用户输入",
      session_id: "会话ID",
      attachments: "附件列表（可选）",
      date: "日期（get_day_history 时使用）",
      type: "状态类型：exp / task",
    },
    output: {
      ok: "操作是否成功",
      waiting: "是否等待用户回复",
      call: "reply | ask_user",
      content: "AI 回复内容",
    },
  };
}
