/**
 * Envelop — 唯一数据载体
 * 与 Python 版 core.py 的 Envelop 完全对应
 */

export interface EnvelopData {
  sender: string;
  receiver: string;
  intent: string;
  payload: Record<string, any>;
  trace_id: string;
  message_id: string;
  channel_id: string;
  ttl: number;
  meta: Record<string, any>;
  created_at: string;
  path_history: string[];
}

export class Envelop {
  sender: string;
  receiver: string;
  intent: string;
  payload: Record<string, any>;
  trace_id: string;
  message_id: string;
  channel_id: string;
  ttl: number;
  meta: Record<string, any>;
  created_at: string;
  path_history: string[];

  constructor(params: {
    sender?: string;
    receiver?: string;
    intent?: string;
    payload?: Record<string, any>;
    channel_id?: string;
    ttl?: number;
    meta?: Record<string, any>;
  } = {}) {
    this.sender = params.sender ?? "";
    this.receiver = params.receiver ?? "";
    this.intent = params.intent ?? "";
    this.payload = params.payload ?? {};
    this.trace_id = `tr_${randomHex(8)}`;
    this.message_id = `msg_${randomHex(6)}`;
    this.channel_id = params.channel_id ?? "";
    this.ttl = params.ttl ?? 10;
    this.meta = params.meta ?? {};
    this.created_at = new Date().toISOString();
    this.path_history = [];
  }

  to_dict(): Record<string, any> {
    return {
      sender: this.sender,
      receiver: this.receiver,
      intent: this.intent,
      payload: this.payload,
      trace_id: this.trace_id,
      message_id: this.message_id,
      channel_id: this.channel_id,
      ttl: this.ttl,
      meta: this.meta,
      created_at: this.created_at,
    };
  }

  static from_dict(data: Record<string, any>): Envelop {
    const env = new Envelop({
      sender: data.sender ?? "",
      receiver: data.receiver ?? "",
      intent: data.intent ?? "",
      payload: data.payload ?? {},
      channel_id: data.channel_id ?? "",
      ttl: data.ttl ?? 10,
      meta: data.meta ?? {},
    });
    env.trace_id = data.trace_id ?? env.trace_id;
    env.message_id = data.message_id ?? env.message_id;
    env.created_at = data.created_at ?? env.created_at;
    return env;
  }
}

/** 生成随机十六进制字符串，等价于 Python 的 uuid.uuid4().hex[:n] */
function randomHex(n: number): string {
  const bytes = new Uint8Array(Math.ceil(n / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, n);
}