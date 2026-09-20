/**
 * LLM — Production-grade multi-provider LLM client.
 *
 * 支持：
 * - 多 provider（OpenAI 兼容 API）
 * - 多 model
 * - roles（role → model 映射）
 * - 重试 + 指数退避
 * - 超时
 * - 并发控制
 * - 错误兜底
 *
 * 与 Python 版 runtime/_llm.py 对应。
 */

// ============================================================
// 常量
// ============================================================

const DEFAULT_REQUEST_TIMEOUT = 60;      // 秒
const DEFAULT_STREAM_TIMEOUT = 300;      // 秒
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_CONCURRENT = 10;

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

const FALLBACK_MESSAGES = {
  not_configured: "[LLM 未配置]",
  empty_response: "[模型返回空响应，请稍后重试]",
  timeout: "[服务请求超时，请稍后重试]",
  max_retries: "[LLM 达到最大重试次数]",
  system_error: "[系统错误]",
  empty: "[空响应]",
};

// ============================================================
// 类型
// ============================================================

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelEntry {
  id: string;
  max_tokens?: number;
  temperature?: number;
  supports_streaming?: boolean;
  high_quality?: boolean;
}

export interface ProviderEntry {
  type?: string;           // "openai"
  api_key?: string;
  base_url?: string;
  models?: ModelEntry[];
}

export interface LLMConfig {
  default?: string;
  roles?: Record<string, string>;
  providers?: Record<string, ProviderEntry>;
  max_retries?: number;
  request_timeout?: number;
  stream_timeout?: number;
  max_concurrent?: number;
}

interface ModelConfig {
  client_name: string;
  max_tokens: number;
  temperature: number;
  supports_streaming: boolean;
  high_quality: boolean;
}

interface ClientEntry {
  name: string;
  api_key: string;
  base_url: string;
}

// ============================================================
// Semaphore（并发控制）
// ============================================================

class Semaphore {
  private _max: number;
  private _current: number;
  private _queue: Array<() => void> = [];

  constructor(max: number) {
    this._max = max;
    this._current = 0;
  }

  async acquire(): Promise<void> {
    if (this._current < this._max) {
      this._current++;
      return;
    }
    return new Promise((resolve) => {
      this._queue.push(() => {
        this._current++;
        resolve();
      });
    });
  }

  release(): void {
    this._current--;
    const next = this._queue.shift();
    if (next) next();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// ============================================================
// 错误检测
// ============================================================

export function isLlmErrorString(text: any): boolean {
  if (typeof text !== "string") return false;
  if (!text) return false;
  return ERROR_PREFIXES.some((p) => text.startsWith(p));
}

// ============================================================
// LLM 类
// ============================================================

export class LLM {
  private _clients: Map<string, ClientEntry> = new Map();
  private _modelToClient: Map<string, string> = new Map();
  private _modelConfigs: Map<string, ModelConfig> = new Map();
  private _roles: Record<string, string> = {};
  private _defaultModel: string = "gpt-3.5-turbo";

  private _maxRetries: number;
  private _requestTimeout: number;
  private _streamTimeout: number;
  private _semaphore: Semaphore;

  constructor(config: LLMConfig = {}) {
    this._roles = config.roles ?? {};
    this._defaultModel =
      this._roles["default"] ?? config.default ?? "gpt-3.5-turbo";

    this._maxRetries = config.max_retries ?? DEFAULT_MAX_RETRIES;
    this._requestTimeout = config.request_timeout ?? DEFAULT_REQUEST_TIMEOUT;
    this._streamTimeout = config.stream_timeout ?? DEFAULT_STREAM_TIMEOUT;
    this._semaphore = new Semaphore(config.max_concurrent ?? DEFAULT_MAX_CONCURRENT);

    this._initClients(config.providers ?? {});

    console.log(
      `[LLM] Default: ${this._defaultModel} | Models: ${this._modelToClient.size}`
    );
  }

  // ============================================================
  // Provider 初始化
  // ============================================================

  private _initClients(providers: Record<string, ProviderEntry>): void {
    for (const [name, cfg] of Object.entries(providers)) {
      const apiKey = cfg.api_key ?? "";
      const baseUrl = cfg.base_url ?? "https://api.openai.com/v1";
      const models = cfg.models ?? [];

      // 跳过未配置的
      if (!apiKey || apiKey.startsWith("${")) {
        console.warn(`[LLM] Skip ${name}: API key not configured`);
        continue;
      }

      this._clients.set(name, {
        name,
        api_key: apiKey,
        base_url: baseUrl,
      });

      for (const m of models) {
        if (!m.id) continue;

        this._modelConfigs.set(m.id, {
          client_name: name,
          max_tokens: m.max_tokens ?? 4096,
          temperature: m.temperature ?? 0.7,
          supports_streaming: m.supports_streaming ?? true,
          high_quality: m.high_quality ?? false,
        });
        this._modelToClient.set(m.id, name);

        console.log(`[LLM] ✅ ${m.id} (${name})`);
      }
    }

    // 校验 default
    if (!this._modelToClient.has(this._defaultModel)) {
      const first = this._modelToClient.keys().next().value;
      if (first) {
        console.warn(
          `[LLM] ⚠️ default model '${this._defaultModel}' unavailable, fallback to '${first}'`
        );
        this._defaultModel = first;
      } else {
        console.warn(`[LLM] ❌ No available model`);
      }
    }
  }

  // ============================================================
  // Model 解析
  // ============================================================

  private _resolveModel(role?: string): string {
    if (!role) return this._defaultModel;
    const model = this._roles[role];
    if (model && this._modelToClient.has(model)) return model;
    if (model) {
      console.warn(`[LLM] ⚠️ role '${role}' = '${model}' unavailable, fallback to default`);
    }
    return this._defaultModel;
  }

  private _getClient(model?: string): { client: ClientEntry | null; resolvedModel: string } {
    const resolvedModel = model || this._defaultModel;
    const clientName = this._modelToClient.get(resolvedModel);

    if (clientName) {
      const client = this._clients.get(clientName);
      if (client) return { client, resolvedModel };
    }

    // fallback 到第一个
    const first = this._clients.values().next().value;
    if (first) return { client: first, resolvedModel };

    return { client: null, resolvedModel };
  }

  // ============================================================
  // 重试
  // ============================================================

  private _calculateBackoff(attempt: number, maxWait: number = 10): number {
    const wait = Math.min(Math.pow(2, attempt), maxWait);
    const jitter = Math.random() * wait * 0.5;
    return wait + jitter;
  }

  // ============================================================
  // 内部：请求
  // ============================================================

  private async _chatImpl(
    messages: ChatMessage[],
    model?: string,
    options: { jsonMode?: boolean; max_tokens?: number; temperature?: number } = {}
  ): Promise<string> {
    const { client, resolvedModel } = this._getClient(model);

    if (!client) {
      return FALLBACK_MESSAGES.not_configured;
    }

    const modelCfg = this._modelConfigs.get(resolvedModel);
    const maxTokens = options.max_tokens ?? modelCfg?.max_tokens ?? 4096;
    const temperature = options.temperature ?? modelCfg?.temperature ?? 0.7;

    const url = `${client.base_url.replace(/\/+$/, "")}/chat/completions`;
    const body: Record<string, any> = {
      model: resolvedModel,
      messages,
      max_tokens: maxTokens,
      temperature,
    };

    if (options.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    let lastError: string = "";

    for (let attempt = 0; attempt < this._maxRetries; attempt++) {
      try {
        console.log(`[LLM] 🔄 API call ${attempt + 1}/${this._maxRetries} → ${resolvedModel}`);
        const t0 = Date.now();

        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          this._requestTimeout * 1000
        );

        let response: Response;
        try {
          response = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${client.api_key}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        if (!response.ok) {
          const text = await response.text();
          lastError = `${response.status} ${text.slice(0, 200)}`;
          console.warn(`[LLM] ❌ HTTP ${response.status}: ${text.slice(0, 100)}`);
          // 4xx 不重试
          if (response.status >= 400 && response.status < 500) {
            break;
          }
          continue;
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;
        const elapsed = (Date.now() - t0) / 1000;

        if (content && content.trim()) {
          console.log(`[LLM] ✅ 成功 (${elapsed.toFixed(1)}s, ${content.length} chars)`);
          return content.trim();
        }

        console.warn(`[LLM] ⚠️ 空响应 (${elapsed.toFixed(1)}s)`);
        lastError = "empty_response";
      } catch (e: any) {
        if (e.name === "AbortError") {
          console.warn(`[LLM] ⏱️ 超时 attempt ${attempt + 1}`);
          lastError = "timeout";
        } else {
          console.warn(`[LLM] ❌ 错误 attempt ${attempt + 1}: ${e.message}`);
          lastError = e.message;
        }
      }

      if (attempt < this._maxRetries - 1) {
        const wait = this._calculateBackoff(attempt);
        console.log(`[LLM] ⏳ 等待 ${wait.toFixed(1)}s 后重试...`);
        await new Promise((r) => setTimeout(r, wait * 1000));
      }
    }

    if (lastError === "timeout") return FALLBACK_MESSAGES.timeout;
    if (lastError === "empty_response") return FALLBACK_MESSAGES.empty_response;
    return `[LLM请求失败: ${lastError.slice(0, 200)}]`;
  }

  // ============================================================
  // 公开：chat
  // ============================================================

  async chat(
    messages: ChatMessage[],
    model?: string,
    role?: string
  ): Promise<string> {
    let resolvedModel: string;
    if (model) resolvedModel = model;
    else if (role) resolvedModel = this._resolveModel(role);
    else resolvedModel = this._defaultModel;

    try {
      return await this._semaphore.run(async () => {
        const result = await this._chatImpl(messages, resolvedModel);
        if (!result || !result.trim()) return FALLBACK_MESSAGES.empty;
        return result;
      });
    } catch (e: any) {
      return `[系统错误: ${String(e).slice(0, 100)}]`;
    }
  }

  // ============================================================
  // 公开：chat_json
  // ============================================================

  async chat_json(
    messages: ChatMessage[],
    model?: string,
    role?: string
  ): Promise<Record<string, any>> {
    const maxAttempts = 3;
    const localMessages = [...messages];
    let lastRaw = "";

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const raw = await this.chat(localMessages, model, role);
      lastRaw = raw;

      if (isLlmErrorString(raw)) {
        if (attempt === maxAttempts - 1) return { error: raw };
        continue;
      }

      const cleaned = this._extractJson(raw);

      try {
        return JSON.parse(cleaned);
      } catch (e: any) {
        console.warn(`[LLM] JSON 解析失败 ${attempt + 1}: ${e.message}`);
        if (attempt === maxAttempts - 1) {
          return { content: cleaned, parse_error: e.message };
        }
        localMessages.push({
          role: "system",
          content: "请只返回有效的 JSON 格式，不要包含任何其他文本。",
        });
      }
    }

    return { content: lastRaw, error: "max_json_attempts_exceeded" };
  }

  private _extractJson(raw: string): string {
    let cleaned = raw.trim();

    if (cleaned.includes("```json")) {
      const parts = cleaned.split("```json", 2);
      if (parts.length > 1) {
        cleaned = parts[1].split("```", 1)[0].trim();
      }
    } else if (cleaned.includes("```")) {
      const parts = cleaned.split("```");
      if (parts.length > 1) {
        cleaned = parts[1].split("```", 1)[0].trim();
      }
    }

    return cleaned;
  }

  // ============================================================
  // 公开：chat_stream
  // ============================================================

  async *chat_stream(
    messages: ChatMessage[],
    model?: string,
    role?: string
  ): AsyncGenerator<string> {
    let resolvedModel: string;
    if (model) resolvedModel = model;
    else if (role) resolvedModel = this._resolveModel(role);
    else resolvedModel = this._defaultModel;

    await this._semaphore.acquire();
    try {
      yield* this._chatStreamImpl(messages, resolvedModel);
    } finally {
      this._semaphore.release();
    }
  }

  private async *_chatStreamImpl(
    messages: ChatMessage[],
    model: string
  ): AsyncGenerator<string> {
    const { client, resolvedModel } = this._getClient(model);

    if (!client) {
      yield FALLBACK_MESSAGES.not_configured;
      return;
    }

    const modelCfg = this._modelConfigs.get(resolvedModel);

    // 不支持流式 → 降级
    if (modelCfg && !modelCfg.supports_streaming) {
      const result = await this._chatImpl(messages, resolvedModel);
      if (result && !isLlmErrorString(result)) {
        yield result;
      } else {
        yield FALLBACK_MESSAGES.empty;
      }
      return;
    }

    const url = `${client.base_url.replace(/\/+$/, "")}/chat/completions`;
    const body = {
      model: resolvedModel,
      messages,
      max_tokens: modelCfg?.max_tokens ?? 4096,
      temperature: modelCfg?.temperature ?? 0.7,
      stream: true,
    };

    for (let attempt = 0; attempt < this._maxRetries; attempt++) {
      try {
        console.log(`[LLM] 📡 stream ${attempt + 1}/${this._maxRetries} → ${resolvedModel}`);

        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          this._streamTimeout * 1000
        );

        let response: Response;
        try {
          response = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${client.api_key}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (e) {
          clearTimeout(timer);
          throw e;
        }

        if (!response.ok || !response.body) {
          clearTimeout(timer);
          throw new Error(`stream failed: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const data = trimmed.slice(5).trim();
              if (data === "[DONE]") return;

              try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) yield delta;
              } catch {
                // ignore malformed chunks
              }
            }
          }
        } finally {
          clearTimeout(timer);
        }

        return;
      } catch (e: any) {
        console.warn(`[LLM] ❌ stream error attempt ${attempt + 1}: ${e.message}`);

        if (attempt === this._maxRetries - 1) {
          yield `[LLM stream error: ${String(e).slice(0, 200)}]`;
          return;
        }

        await new Promise((r) =>
          setTimeout(r, this._calculateBackoff(attempt) * 1000)
        );
      }
    }

    yield FALLBACK_MESSAGES.max_retries;
  }
}