/**
 * cogitor — AICP 系统概览（分组 + 描述 + 搜索版）
 * =========================================
 * 无状态、实时、按需。
 *
 * - get_map：系统概览（分类 + 数量 + 描述）
 * - list_plugins：一次返回 分类 + 插件名 + 描述
 * - search：按词搜索（支持 terms 列表 / query 字符串）
 *
 * 分类规则：
 *   applications/xxx/yyy → 按项目分组（projects）
 *   其他（builtins/xxx、os/xxx、shell/xxx）→ 归到一级分类（plugins）
 *   www/xxx → 跳过（前端插件，不是后端能力）
 *
 * 描述来源（按优先级）：
 *   1. 真正的 help() 里的 description 字段（export function help，其次行首无缩进的 function help）
 *   2. @AICP_ALIGN 的 actions 列表
 *   3. 模块顶部注释第一行
 *   4. 空字符串
 */

import { Envelop } from "../../../core/Envelop.js";
import type { Agent } from "../../../core/Agent.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================
// 常量
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ★ cogitor.ts 在 src/plugins/builtins/agents/cogitor.ts
// 往上 2 级到 src/plugins
const PLUGINS_ROOT = path.resolve(__dirname, "..", "..");

const PER_GROUP_LIMIT = 15;      // 每个分类最多列 15 个插件
const PER_PROJECT_LIMIT = 20;    // applications 最多列 20 个项目

// 描述缓存
const _descCache = new Map<string, string>();

// ============================================================
// 描述提取
// ============================================================

function extractDesc(pluginName: string): string {
  if (_descCache.has(pluginName)) {
    return _descCache.get(pluginName)!;
  }

  let desc = "";

  for (const suffix of [".ts", ".js", ".py"]) {
    const f = path.join(PLUGINS_ROOT, `${pluginName}${suffix}`);
    if (!fs.existsSync(f)) continue;

    try {
      const content = fs.readFileSync(f, "utf-8");

      // ---- 1. description 字段（只匹配真正的 help() 之后的） ----
      // ★ 用 lastIndexOf，找文件末尾的真 help()（create_tool 的模板字符串里有假的）
      let helpPos = content.lastIndexOf("export function help");
      if (helpPos === -1) {
        // 退回行首无缩进的 function help（取最后一个）
        const matches = [...content.matchAll(/^function help\s*\(/gm)];
        helpPos = matches.length > 0 ? matches[matches.length - 1].index! : -1;
      }
      const searchFrom = helpPos !== -1 ? helpPos : 0;
      const searchWindow = content.slice(searchFrom, searchFrom + 800);

      const m1 = searchWindow.match(
        /["']?description["']?\s*[:=]\s*["']([^"']{1,100})["']/
      );
      if (m1) {
        let d = m1[1].trim().replace(/["']+$/, "");
        if (d.includes("${")) {
          d = "";
        }
        if (d) {
          desc = d;
          break;
        }
      }

      // ---- 2. @AICP_ALIGN 的 actions ----
      const m2 = content.match(/@AICP_ALIGN:\s*actions=([^\n|]+)/);
      if (m2) {
        const actions = m2[1]
          .split(",")
          .map((a) => a.trim())
          .filter((a) => a.length > 0);
        if (actions.length > 0) {
          desc = actions.slice(0, 3).join(", ");
          if (actions.length > 3) {
            desc += ` 等 ${actions.length} 个`;
          }
          break;
        }
      }

      // ---- 3. 模块顶部注释第一行 ----
      const m3 = content.match(/^\s*\/\*\*?\s*\n?\s*\*?\s*(.{1,100}?)\n/);
      if (m3) {
        let d = m3[1].trim().replace(/["']+$/, "");
        if (
          d &&
          !d.startsWith("import ") &&
          !d.startsWith("//") &&
          !d.includes("${")
        ) {
          desc = d;
          break;
        }
      }
    } catch {
      // 忽略读文件错误
    }
  }

  if (desc.length > 50) {
    desc = desc.slice(0, 48) + "…";
  }

  _descCache.set(pluginName, desc);
  return desc;
}

// ============================================================
// 拆词：按非中英文数字的符号拆，保留 _ 和 -
// ============================================================

function tokenize(query: string): string[] {
  if (!query) return [];
  const tokens = query
    .trim()
    .split(/[^\u4e00-\u9fffa-zA-Z0-9_-]+/)
    .filter((t) => t.length > 0);
  return tokens.map((t) => t.toLowerCase());
}

// ============================================================
// 从 _registry 获取插件列表
// ============================================================

async function fetchPluginNames(agent: Agent): Promise<string[]> {
  const result = await agent.system.call(
    new Envelop({
      sender: "builtins/agents/cogitor",
      receiver: "os/_registry",
      payload: { action: "list" },
    })
  );

  if (!result?.payload?.ok) {
    throw new Error("无法获取插件列表");
  }

  const list = result.payload.plugins ?? [];
  return list.filter(
    (n: unknown): n is string => typeof n === "string" && n.length > 0
  );
}

// ============================================================
// 分组 + 描述
// ============================================================

interface GroupEntry {
  plugins?: { name: string; desc: string }[];
  count?: number;
  more?: number;
  projects?: Record<string, { count: number; desc: string }>;
  total_projects?: number;
  more_projects?: number;
}

function groupWithDesc(pluginNames: string[]): Record<string, GroupEntry> {
  // 先分组
  const groups: Record<string, {
    plugins?: string[];
    projects?: Record<string, string[]>;
  }> = {};

  for (const name of pluginNames) {
    if (!name) continue;
    const parts = name.split("/");

    // ★ 跳过 www/ 前端插件（它们不是后端能力）
    if (parts[0] === "www") continue;

    // ★ 只有 applications 下的才是"项目"
    if (parts[0] === "applications" && parts.length >= 3) {
      const category = "applications";
      const project = parts[1];
      if (!groups[category]) groups[category] = {};
      if (!groups[category].projects) groups[category].projects = {};
      if (!groups[category].projects![project]) {
        groups[category].projects![project] = [];
      }
      groups[category].projects![project].push(name);
    } else {
      const category = parts[0] || "_root";
      if (!groups[category]) groups[category] = {};
      if (!groups[category].plugins) groups[category].plugins = [];
      groups[category].plugins!.push(name);
    }
  }

  // 精简 + 加描述
  const result: Record<string, GroupEntry> = {};

  for (const cat of Object.keys(groups).sort()) {
    if (cat === "_root") continue;
    const info = groups[cat];

    if (info.projects && Object.keys(info.projects).length > 0) {
      const projBrief: Record<string, { count: number; desc: string }> = {};
      let shown = 0;

      for (const proj of Object.keys(info.projects).sort()) {
        if (shown >= PER_PROJECT_LIMIT) break;
        const plugins = info.projects[proj];
        let desc = "";
        for (const p of plugins) {
          const d = extractDesc(p);
          if (d) {
            desc = d;
            break;
          }
        }
        projBrief[proj] = { count: plugins.length, desc };
        shown++;
      }

      const totalProjects = Object.keys(info.projects).length;
      const entry: GroupEntry = {
        projects: projBrief,
        count: Object.values(projBrief).reduce((s, p) => s + p.count, 0),
        total_projects: totalProjects,
      };
      if (totalProjects > PER_PROJECT_LIMIT) {
        entry.more_projects = totalProjects - PER_PROJECT_LIMIT;
      }
      result[cat] = entry;
    } else if (info.plugins && info.plugins.length > 0) {
      const plugins = info.plugins.sort();
      const shown = plugins.slice(0, PER_GROUP_LIMIT);
      const pluginBrief = shown.map((p) => ({
        name: p,
        desc: extractDesc(p),
      }));
      const entry: GroupEntry = {
        plugins: pluginBrief,
        count: plugins.length,
      };
      if (plugins.length > PER_GROUP_LIMIT) {
        entry.more = plugins.length - PER_GROUP_LIMIT;
      }
      result[cat] = entry;
    }
  }

  return result;
}

// ============================================================
// 格式化概览文本
// ============================================================

function formatGroupSummary(groups: Record<string, GroupEntry>, total: number): string {
  const lines: string[] = [`系统共有 ${total} 个后端插件。`, ""];
  lines.push("【插件分组】");
  lines.push("");

  for (const category of Object.keys(groups).sort()) {
    const info = groups[category];
    const count = info.count ?? 0;

    if (info.projects) {
      const totalProjects = info.total_projects ?? Object.keys(info.projects).length;
      lines.push(`  • ${category}（${count} 个插件，${totalProjects} 个项目）`);
      for (const proj of Object.keys(info.projects).sort()) {
        const p = info.projects[proj];
        const desc = p.desc ? ` — ${p.desc}` : "";
        lines.push(`      - ${proj}（${p.count} 个）${desc}`);
      }
      if (info.more_projects) {
        lines.push(`      - ... 还有 ${info.more_projects} 个项目`);
      }
    } else if (info.plugins) {
      lines.push(`  • ${category}（${count} 个）`);
      for (const p of info.plugins) {
        const desc = p.desc ? ` — ${p.desc}` : "";
        lines.push(`      - ${p.name}${desc}`);
      }
      if (info.more) {
        lines.push(`      - ... 还有 ${info.more} 个`);
      }
    }
  }

  return lines.join("\n");
}

// ============================================================
// 搜索
// ============================================================

interface SearchResult {
  name: string;
  desc: string;
  score: number;
  matched_terms: string[];
  match_detail: Record<string, string[]>;
  desc_matched: { term: string; snippet: string }[];
}

function termSearch(
  terms: string[],
  pluginNames: string[],
  limit: number = 10,
  mode: "any" | "all" = "any"
): SearchResult[] {
  if (!terms || terms.length === 0) return [];

  // 统一小写，去空白
  const normalizedTerms = terms
    .map((t) => (t || "").toLowerCase().trim())
    .filter((t) => t.length > 0);
  if (normalizedTerms.length === 0) return [];

  const results: SearchResult[] = [];

  for (const name of pluginNames) {
    const desc = extractDesc(name);
    const nameLower = name.toLowerCase();
    const descLower = desc.toLowerCase();

    let score = 0;
    const matchedTerms: string[] = [];
    const matchDetail: Record<string, string[]> = {};
    const descMatched: { term: string; snippet: string }[] = [];

    for (const term of normalizedTerms) {
      let termScore = 0;
      const matchedIn: string[] = [];

      if (nameLower.includes(term)) {
        termScore += 10;
        matchedIn.push("name");
      }
      if (descLower.includes(term)) {
        termScore += 5;
        matchedIn.push("desc");
        // 提取描述里的命中片段
        const idx = descLower.indexOf(term);
        if (idx >= 0) {
          const start = Math.max(0, idx - 20);
          const end = Math.min(desc.length, idx + term.length + 20);
          let snippet = desc.slice(start, end);
          if (start > 0) snippet = "…" + snippet;
          if (end < desc.length) snippet = snippet + "…";
          descMatched.push({ term, snippet });
        }
      }

      if (termScore > 0) {
        score += termScore;
        matchedTerms.push(term);
        matchDetail[term] = matchedIn;
      }
    }

    // 模式判断
    if (mode === "all") {
      if (matchedTerms.length < normalizedTerms.length) continue;
    } else {
      if (matchedTerms.length === 0) continue;
    }

    // 加分
    if (desc) score += 2;
    score += matchedTerms.length * 3;

    results.push({
      name,
      desc,
      score,
      matched_terms: matchedTerms,
      match_detail: matchDetail,
      desc_matched: descMatched,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// ============================================================
// 主入口
// ============================================================

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const action = envelop.payload?.action ?? "get_map";

  // ============================================================
  // get_map：系统概览
  // ============================================================
  if (action === "get_map") {
    let pluginNames: string[];
    try {
      pluginNames = await fetchPluginNames(agent);
    } catch (e) {
      envelop.payload = { ok: false, error: `${e}` };
      return envelop;
    }

    // ★ 统计时也跳过 www
    const backendNames = pluginNames.filter((n) => !n.startsWith("www/"));
    const groups = groupWithDesc(backendNames);
    const totalPlugins = backendNames.length;

    const summaryLines: string[] = [
      `系统共有 ${totalPlugins} 个后端插件。`,
      "",
    ];
    summaryLines.push(formatGroupSummary(groups, totalPlugins));

    envelop.payload = {
      ok: true,
      summary: summaryLines.join("\n"),
      data: {
        total_plugins: totalPlugins,
        groups,
      },
    };
    return envelop;
  }

  // ============================================================
  // list_plugins：一次返回分组 + 插件名 + 描述
  // ============================================================
  if (action === "list_plugins") {
    let pluginNames: string[];
    try {
      pluginNames = await fetchPluginNames(agent);
    } catch (e) {
      envelop.payload = { ok: false, error: `${e}` };
      return envelop;
    }

    // ★ 跳过 www
    const backendNames = pluginNames.filter((n) => !n.startsWith("www/"));

    const category = (envelop.payload?.category ?? "").trim();

    // ---- 带 category：返回该分类的完整列表 ----
    if (category) {
      const matched = backendNames.filter(
        (n) => n === category || n.startsWith(category + "/")
      );
      if (matched.length === 0) {
        envelop.payload = {
          ok: false,
          error: `没有找到分类或插件: ${category}`,
          hint: "先用 list_plugins 不带参数查看所有分类",
        };
        return envelop;
      }

      const plugins = matched
        .sort()
        .map((m) => ({ name: m, desc: extractDesc(m) }));
      envelop.payload = {
        ok: true,
        category,
        plugins,
        total: plugins.length,
      };
      return envelop;
    }

    // ---- 不带 category：一次返回分组 + 插件名 + 描述 ----
    const groups = groupWithDesc(backendNames);
    envelop.payload = {
      ok: true,
      groups,
      total: backendNames.length,
      hint: `每个分类最多列 ${PER_GROUP_LIMIT} 个，超出用 more 标记。想看完整列表用 list_plugins category=<分类>`,
    };
    return envelop;
  }

  // ============================================================
  // search：按词搜索
  // ============================================================
  if (action === "search") {
    // 优先 terms，其次 query
    let terms: string[] = envelop.payload?.terms ?? [];
    if (!Array.isArray(terms) || terms.length === 0) {
      const query = (envelop.payload?.query ?? "").trim();
      terms = tokenize(query);
    }

    if (terms.length === 0) {
      envelop.payload = { ok: false, error: "缺少 terms 或 query 参数" };
      return envelop;
    }

    const limit = envelop.payload?.limit ?? 10;
    const mode = envelop.payload?.mode === "all" ? "all" : "any";

    let pluginNames: string[];
    try {
      pluginNames = await fetchPluginNames(agent);
    } catch (e) {
      envelop.payload = { ok: false, error: `${e}` };
      return envelop;
    }

    // 跳过 www
    const backendNames = pluginNames.filter((n) => !n.startsWith("www/"));
    const results = termSearch(terms, backendNames, limit, mode);

    envelop.payload = {
      ok: true,
      terms,
      results,
      total: results.length,
    };
    return envelop;
  }

  envelop.payload = { ok: false, error: `未知 action: ${action}` };
  return envelop;
}

// ============================================================
// help
// ============================================================

export function help() {
  return {
    route: "builtins/agents/cogitor",
    description: "系统概览 — 分组+描述+搜索",
    input: {
      action: "get_map | list_plugins | search",
      category: "（list_plugins 可选）分类名，如 builtins、os、applications",
      terms: '（search 可选）词列表，如 ["股票", "stock"]',
      query: "（search 可选）查询字符串，会按空格/标点拆词",
      limit: "（search 可选）返回数量，默认 10",
      mode: "（search 可选）any 任一命中 | all 全部命中，默认 any",
    },
    output: {
      ok: "是否成功",
      summary: "系统概览文本（get_map）",
      groups: "分组+插件名+描述（list_plugins 无参数）",
      plugins: "完整插件列表（list_plugins 指定 category）",
      results: "搜索结果（search）",
    },
    examples: [
      'search terms=["股票","stock"] → {"results": [{"name": "...", "desc": "...", "match_detail": {...}}]}',
      'search query="股票 stock" → 同上（query 会被拆成 ["股票","stock"]）',
    ],
  };
}
