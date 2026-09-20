/**
 * search_memory — 搜索历史记忆
 *
 * 统一 action 模式：
 * - search：搜索并生成回答（默认）
 *
 * 流程：
 * 1. 读取 flow 文件（根目录 + 日期归档）
 * 2. 关键词打分 → 锚点
 * 3. 补全因果链（user ↔ ai）
 * 4. 去重 + 过滤 system
 * 5. LLM 生成回答
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Envelop } from "../../../core/Envelop.js";
import type { Agent } from "../../../core/Agent.js";

// ============================================================
// 路径
// ============================================================

const MEMORY_DIR = "data/memories/main_agent";
const FLOWS_DIR = join(MEMORY_DIR, "flows");

// ============================================================
// 日期工具
// ============================================================

function parseDate(dateStr: string): Date | null {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  return d;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return formatDate(d);
}

function today(): string {
  return formatDate(new Date());
}

// ============================================================
// 文件读取
// ============================================================

async function getFlowFiles(
  sessionId: string,
  dateFrom?: string,
  dateTo?: string
): Promise<string[]> {
  const files: string[] = [];

  // 1. 根目录（当前会话完整数据）
  const rootFile = join(MEMORY_DIR, `${sessionId}_flow.json`);
  if (existsSync(rootFile)) {
    files.push(rootFile);
  }

  // 2. 日期目录（历史归档）
  if (existsSync(FLOWS_DIR)) {
    const start = dateFrom ? parseDate(dateFrom) : new Date(Date.now() - 30 * 86400_000);
    const end = dateTo ? parseDate(dateTo) : new Date();

    if (start && end) {
      const current = new Date(start);
      while (current <= end) {
        const dateKey = formatDate(current);
        const dayDir = join(FLOWS_DIR, dateKey);
        const flowFile = join(dayDir, `${sessionId}.json`);
        if (existsSync(flowFile) && !files.includes(flowFile)) {
          files.push(flowFile);
        }
        current.setUTCDate(current.getUTCDate() + 1);
      }
    } else {
      console.warn(`[search_memory] 日期解析失败，跳过归档扫描: ${dateFrom} ~ ${dateTo}`);
    }
  }

  return files;
}

async function getAllEntries(
  sessionId: string,
  dateFrom?: string,
  dateTo?: string
): Promise<any[]> {
  const files = await getFlowFiles(sessionId, dateFrom, dateTo);
  if (files.length === 0) return [];

  const allEntries: any[] = [];
  for (const filePath of files) {
    try {
      const content = await readFile(filePath, "utf-8");
      const entries = JSON.parse(content);
      if (Array.isArray(entries)) {
        allEntries.push(...entries);
      }
    } catch {
      // 忽略损坏文件
    }
  }

  allEntries.sort((a, b) =>
    String(a?.timestamp ?? "").localeCompare(String(b?.timestamp ?? ""))
  );
  return allEntries;
}

// ============================================================
// 打分 / 提取
// ============================================================

function getSearchableText(entry: any): string {
  const parts: string[] = [];

  const content = entry?.content ?? "";
  if (content) parts.push(String(content));

  const summary = entry?.summary ?? "";
  if (summary) parts.push(String(summary));

  if (entry?.from === "system") {
    const result = entry?.result ?? "";
    if (result) parts.push(String(result));
  }

  return parts.join(" ").toLowerCase();
}

function scoreEntry(entry: any, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const text = getSearchableText(entry);
  if (!text) return 0;
  let score = 0;
  for (const kw of keywords) {
    if (kw && text.includes(kw.toLowerCase())) score++;
  }
  return score;
}

function extractAiContent(entry: any): string {
  const content = entry?.content ?? "";
  if (content) return String(content);
  const summary = entry?.summary ?? "";
  if (summary) return String(summary);
  return "";
}

function deduplicateEntries(entries: any[]): any[] {
  const seen = new Set<string>();
  const result: any[] = [];
  for (const entry of entries) {
    const content = entry?.content || entry?.summary || "";
    const key = `${entry?.timestamp ?? ""}|${entry?.from ?? ""}|${content}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(entry);
    }
  }
  return result;
}

function buildCleanEntry(entry: any): any {
  const fromUser = entry?.from ?? "";

  const clean: any = {
    timestamp: entry?.timestamp ?? "",
    from: fromUser,
  };

  if (fromUser === "user") {
    clean.content = entry?.content ?? "";
  } else if (fromUser === "ai") {
    const content = extractAiContent(entry);
    clean.content = content || entry?.summary || "";
  }

  return clean;
}

// ============================================================
// 搜索 + 因果链补全
// ============================================================

async function searchEntriesWithContext(
  sessionId: string,
  keywords: string[],
  dateFrom: string,
  dateTo: string,
  limit: number = 50
): Promise<{ entries: any[]; total: number }> {
  // 0. 关键词去重 + 去空
  const kws = Array.from(
    new Set(keywords.map((k) => k?.trim()).filter((k) => k))
  );

  // 1. 获取所有条目
  const allEntries = await getAllEntries(sessionId, dateFrom, dateTo);
  if (allEntries.length === 0) return { entries: [], total: 0 };

  const total = allEntries.length;

  // 2. 打分
  const scored: Array<[number, number]> = [];
  for (let i = 0; i < allEntries.length; i++) {
    const score = scoreEntry(allEntries[i], kws);
    if (score > 0) scored.push([score, i]);
  }

  if (scored.length === 0) return { entries: [], total };

  // 3. 按分数排序，取前 30 个锚点
  scored.sort((a, b) => b[0] - a[0]);
  const anchorIndices = scored.slice(0, 30).map(([, idx]) => idx);

  // 4. 补全因果链（步长 20）
  const expandedIndices = new Set<number>();
  for (const idx of anchorIndices) {
    const entry = allEntries[idx];
    const fromUser = entry?.from ?? "";

    if (fromUser === "ai") {
      // AI → 往前找最近的 user
      for (let prev = idx - 1; prev > Math.max(0, idx - 20); prev--) {
        if (allEntries[prev]?.from === "user") {
          expandedIndices.add(prev);
          break;
        }
      }
      expandedIndices.add(idx);
    } else if (fromUser === "user") {
      // user → 往后找最近的 ai
      expandedIndices.add(idx);
      for (let next = idx + 1; next < Math.min(allEntries.length, idx + 20); next++) {
        if (allEntries[next]?.from === "ai") {
          expandedIndices.add(next);
          break;
        }
      }
    } else if (fromUser === "system") {
      const action = entry?.action ?? "";
      if (String(action).includes("reply")) {
        for (let prev = idx - 1; prev > Math.max(0, idx - 20); prev--) {
          if (allEntries[prev]?.from === "user") {
            expandedIndices.add(prev);
            break;
          }
        }
        expandedIndices.add(idx);
      }
    }
  }

  // 5. 去重 + 排序
  const uniqueIndices = Array.from(expandedIndices).sort((a, b) => a - b);

  // 6. 构建干净条目（只保留 user / ai）
  let cleanEntries: any[] = [];
  for (const idx of uniqueIndices) {
    const entry = allEntries[idx];
    const fromUser = entry?.from ?? "";
    if (fromUser === "user" || fromUser === "ai") {
      cleanEntries.push(buildCleanEntry(entry));
    }
  }

  // 7. 再次去重
  cleanEntries = deduplicateEntries(cleanEntries);

  // 8. 按时间排序
  cleanEntries.sort((a, b) =>
    String(a?.timestamp ?? "").localeCompare(String(b?.timestamp ?? ""))
  );

  // 9. 截断
  if (cleanEntries.length > limit) {
    cleanEntries = cleanEntries.slice(0, limit);
  }

  return { entries: cleanEntries, total };
}

// ============================================================
// LLM 生成回答
// ============================================================

async function generateAnswer(
  agent: Agent,
  query: string,
  entries: any[],
  dateFrom: string,
  dateTo: string
): Promise<string> {
  if (entries.length === 0) {
    return `在 ${dateFrom} ~ ${dateTo} 期间，未找到与「${query}」相关的记录。`;
  }

  const itemsJson = JSON.stringify(entries, null, 2);

  const prompt = `用户想问：${query}

时间范围：${dateFrom} ~ ${dateTo}
匹配到的对话记录（已按时间排序，已过滤系统噪音）：

${itemsJson}

请根据这些记录，回答用户的问题。
要求：
- 如果记录中有明确答案，直接回答
- 如果记录中包含关键信息（如邮箱、地址、账号、网址等），一定要提取出来
- 按时间顺序还原事件过程
- 如果记录不足以回答问题，说明"当前记录中未找到足够信息"
- 不要输出原始记录，直接回答问题
`;

  try {
    if (!agent.llm) {
      return `LLM 未配置，无法生成回答。\n\n匹配到的记录摘要：\n${itemsJson.slice(0, 1500)}`;
    }

    const raw = await agent.llm.chat([{ role: "user", content: prompt }]);
    if (!raw || !raw.trim()) {
      return `找到 ${entries.length} 条相关记录，但生成回答时返回空。\n\n匹配到的记录摘要：\n${itemsJson.slice(0, 1500)}`;
    }
    return raw.trim();
  } catch (e: any) {
    return `生成回答失败：${e?.message ?? e}`;
  }
}

// ============================================================
// 主入口
// ============================================================

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  // 统一 action 模式
  const action = envelop.payload?.action ?? "search";

  // 兼容两种传参：payload.params.xxx 或 payload.xxx
  let params = envelop.payload?.params ?? {};
  if (Object.keys(params).length === 0) {
    params = { ...envelop.payload };
  }

  // action 校验
  if (action !== "search") {
    envelop.payload = { ok: false, error: `未知 action: ${action}` };
    return envelop;
  }

  const sessionId = params.session_id;
  if (!sessionId) {
    envelop.payload = { ok: false, error: "缺少 session_id" };
    return envelop;
  }

  const query = params.query;
  if (!query) {
    envelop.payload = { ok: false, error: "缺少 query 参数" };
    return envelop;
  }

  let keywords = params.keywords ?? [];
  if (typeof keywords === "string") {
    keywords = [keywords];
  }
  if (!Array.isArray(keywords) || keywords.length === 0) {
    envelop.payload = { ok: false, error: "缺少 keywords 参数" };
    return envelop;
  }

  let dateFrom = params.date_from;
  let dateTo = params.date_to;

  dateFrom = dateFrom || daysAgo(30);
  dateTo = dateTo || today();

  // 搜索 + 补全因果链
  const { entries, total } = await searchEntriesWithContext(
    sessionId,
    keywords,
    dateFrom,
    dateTo,
    50
  );

  // 生成回答
  const answer = await generateAnswer(agent, query, entries, dateFrom, dateTo);

  envelop.payload = {
    ok: true,
    answer,
    matched_count: entries.length,
    total_in_range: total,
    range: `${dateFrom} ~ ${dateTo}`,
    keywords,
  };
  return envelop;
}

// ============================================================
// help
// ============================================================

export function help() {
  return {
    route: "builtins/agents/search_memory",
    description: "搜索历史记忆，根据关键词过滤，补全因果链，返回详细回答",
    input: {
      action: "search（默认）",
      session_id: "会话ID（必填）",
      query: "用户想问的问题（必填）",
      keywords: "关键词列表或字符串（必填），匹配任意一个即命中",
      date_from: "开始日期 YYYY-MM-DD（可选，默认30天前）",
      date_to: "结束日期 YYYY-MM-DD（可选，默认今天）",
    },
    output: {
      ok: "是否成功",
      answer: "LLM 生成的详细回答",
      matched_count: "匹配到的记录数",
      total_in_range: "时间范围内的总记录数",
      range: "搜索的时间范围",
      keywords: "使用的关键词",
    },
  };
}