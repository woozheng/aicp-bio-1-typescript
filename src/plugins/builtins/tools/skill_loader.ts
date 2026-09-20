/**
 * skill_loader — 技能加载器（搜索 + 加载 + 管理）
 *
 * 与 Python 版 skill_loader_api.py + load_skill.py 对齐。
 *
 * action：
 * - scan：扫 data/skills/，建索引
 * - list：列技能（自动 scan）
 * - search：搜技能（自动 scan + 粗筛 + LLM 精排）
 * - detail：查详情
 * - categories：列分类
 * - stats：统计
 * - load：加载技能到 active_skills（支持模糊匹配）
 * - clear：清空当前技能
 * - get_active：查看当前技能
 * - save_active：保存当前技能
 */

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { Envelop } from "../../../core/Envelop.js";
import type { Agent } from "../../../core/Agent.js";

// ============================================================
// 常量
// ============================================================

const DATA_DIR = "data/skill_loader";
const SKILLS_DIR = "data/skills";
const INDEX_FILE = join(DATA_DIR, "index.json");

const ACTIVE_SKILL_DIR = "data/memories/main_agent/active_skills";

// ============================================================
// 黑名单关键词
// ============================================================

const BLOCKLIST_KEYWORDS = [
  "godmode",
  "jailbreak",
  "uncensoring",
  "uncensor",
  "red-teaming",
  "redteam",
  "safety-bypass",
  "bypass-safety",
  "refusal-removal",
  "abliteration",
  "guardrail-removal",
  "remove-guardrails",
  "excision",
  "model-surgery",
  "g0dm0d3",
  "obliterator",
  "obliteratus",
  "uncensored",
  "bypass",
  "越狱",
  "绕过",
  "去审查",
  "红队",
];

// ============================================================
// 分类映射
// ============================================================

const CATEGORY_MAP: Record<string, string> = {
  debugging: "software-development",
  testing: "software-development",
  tdd: "software-development",
  "code-review": "software-development",
  quality: "software-development",
  development: "software-development",
  planning: "software-development",
  implementation: "software-development",
  workflow: "software-development",
  documentation: "software-development",
  subagent: "software-development",
  delegation: "software-development",
  parallel: "software-development",
  mlops: "mlops",
  "fine-tuning": "mlops",
  training: "mlops",
  evaluation: "mlops",
  benchmarking: "mlops",
  inference: "mlops",
  huggingface: "mlops",
  peft: "mlops",
  lora: "mlops",
  qlora: "mlops",
  trl: "mlops",
  rlhf: "mlops",
  design: "design",
  ui: "design",
  ux: "design",
  brand: "design",
  visual: "design",
  inclusive: "design",
  github: "devops",
  git: "devops",
  devops: "devops",
  webhook: "devops",
  sync: "devops",
  backup: "devops",
  deployment: "devops",
  creative: "creative",
  "generative-art": "creative",
  p5js: "creative",
  "creative-coding": "creative",
  interactive: "creative",
  visualization: "creative",
  canvas: "creative",
  shaders: "creative",
  animation: "creative",
  ascii: "creative",
  legal: "legal",
  contract: "legal",
  policy: "legal",
  compliance: "legal",
  gaming: "gaming",
  pokemon: "gaming",
  emulator: "gaming",
  gameplay: "gaming",
  hermes: "hermes",
  autonomous: "autonomous-ai",
  agent: "autonomous-ai",
  "multi-agent": "autonomous-ai",
  spawning: "autonomous-ai",
  gateway: "autonomous-ai",
  unity: "unity",
  blender: "blender",
  "paid-media": "paid-media",
  tracking: "paid-media",
  attribution: "paid-media",
  engineering: "engineering",
  media: "media",
  audio: "media",
  spectrogram: "media",
  research: "research",
  productivity: "productivity",
  google: "productivity",
  gmail: "productivity",
  calendar: "productivity",
  drive: "productivity",
  sheets: "productivity",
  apple: "apple",
  imessage: "apple",
  macos: "apple",
};

// ============================================================
// 索引读写
// ============================================================

async function loadIndex(): Promise<any> {
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(INDEX_FILE)) {
    return { skills: [], categories: [], last_scan: null, skipped: [] };
  }
  try {
    return JSON.parse(await readFile(INDEX_FILE, "utf-8"));
  } catch {
    return { skills: [], categories: [], last_scan: null, skipped: [] };
  }
}

async function saveIndex(data: any): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(INDEX_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// ============================================================
// 黑名单 / 分类
// ============================================================

function isBlockedSkill(skill: any): boolean {
  const title = (skill.title ?? "").toLowerCase();
  const desc = (skill.description ?? "").toLowerCase();
  const tags = (skill.tags ?? []).join(" ").toLowerCase();
  const combined = `${title} ${desc} ${tags}`;
  for (const kw of BLOCKLIST_KEYWORDS) {
    if (combined.includes(kw)) return true;
  }
  return false;
}

function determineCategoryFromTags(tags: string[], filePath: string): string {
  for (const tag of tags) {
    const t = tag.toLowerCase();
    if (t in CATEGORY_MAP) return CATEGORY_MAP[t];
  }

  const parts = filePath.split("/").filter(Boolean);
  if (parts.length >= 2) {
    const dirName = parts[0];
    const knownCats = Object.values(CATEGORY_MAP);
    if (knownCats.includes(dirName)) return dirName;
    for (const [key, cat] of Object.entries(CATEGORY_MAP)) {
      if (dirName.toLowerCase().includes(key)) return cat;
    }
    return dirName;
  }

  return "未分类";
}

// ============================================================
// 解析 SKILL.md
// ============================================================

async function parseSkillMd(filePath: string): Promise<any | null> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  const lines = content.split("\n");
  let title = "";
  let description = "";
  let category = "未分类";
  let tags: string[] = [];
  let fmEnd = 0;

  if (lines.length > 0 && lines[0].trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        fmEnd = i + 1;
        break;
      }
      const line = lines[i].trim();
      if (line.startsWith("title:")) {
        title = line.slice(6).trim().replace(/^["']|["']$/g, "");
      } else if (line.startsWith("description:")) {
        description = line.slice(12).trim().replace(/^["']|["']$/g, "");
      } else if (line.startsWith("category:")) {
        category = line.slice(9).trim().replace(/^["']|["']$/g, "");
      } else if (line.startsWith("tags:")) {
        const tagStr = line.slice(5).trim();
        if (tagStr.startsWith("[") && tagStr.endsWith("]")) {
          tags = tagStr
            .slice(1, -1)
            .split(",")
            .map((t) => t.trim().replace(/^["']|["']$/g, ""))
            .filter(Boolean);
        }
      }
    }
  }

  if (!title) {
    for (let i = fmEnd; i < lines.length; i++) {
      if (lines[i].startsWith("# ")) {
        title = lines[i].slice(2).trim();
        break;
      }
    }
  }
  if (!title) {
    title = filePath.split(/[/\\]/).pop()?.replace(".md", "") ?? "";
  }

  if (!description) {
    for (let i = fmEnd; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line && !line.startsWith("#")) {
        description = line.slice(0, 200);
        break;
      }
    }
  }

  const relPath = relative(SKILLS_DIR, filePath).replace(/\\/g, "/");
  // ★ 用目录名作为 skill_id（去掉末尾的 /SKILL.md 或 SKILL.md）
  let skillId = relPath
    .replace(/\/SKILL\.md$/i, "")     // 去掉 /SKILL.md
    .replace(/^SKILL\.md$/i, "")       // 根目录 SKILL.md 的情况
    .replace(/\//g, "_")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_");
  // 兜底
  if (!skillId) {
    skillId = filePath.split(/[/\\]/).pop()?.replace(".md", "").toLowerCase() ?? "unknown";
  }

  if (category === "未分类" || !category) {
    category = determineCategoryFromTags(tags, relPath);
  }

  return {
    skill_id: skillId,
    title,
    description,
    category,
    tags,
    file_path: relPath,
    skill_dir: dirname(filePath),
    content,
  };
}

// ============================================================
// 扫描技能
// ============================================================

async function scanSkills(): Promise<any> {
  await mkdir(SKILLS_DIR, { recursive: true });

  const mdFiles: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name === "SKILL.md") {
        mdFiles.push(full);
      }
    }
  }
  await walk(SKILLS_DIR);

  const skills: any[] = [];
  const categoriesSet = new Set<string>();
  const blockedTitles: string[] = [];

  for (const f of mdFiles) {
    const skill = await parseSkillMd(f);
    if (!skill) continue;

    if (isBlockedSkill(skill)) {
      blockedTitles.push(skill.title ?? f);
      continue;
    }

    skills.push(skill);
    categoriesSet.add(skill.category);
  }

  const categories = Array.from(categoriesSet).sort();
  const data = {
    skills,
    categories,
    last_scan: new Date().toISOString().replace("T", " ").slice(0, 19),
    skipped: blockedTitles,
  };
  await saveIndex(data);
  return data;
}

// ============================================================
// 模糊匹配
// ============================================================

function fuzzyMatch(query: string, text: string, threshold: number = 0.3): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0 || t.length === 0) return 0;
  if (t.includes(q)) return 1.0;

  // 简易相似度：最长公共子串长度 / max(len)
  let maxLen = 0;
  for (let i = 0; i < q.length; i++) {
    for (let j = i + 1; j <= q.length; j++) {
      const sub = q.slice(i, j);
      if (t.includes(sub)) {
        maxLen = Math.max(maxLen, sub.length);
      }
    }
  }
  const ratio = (2 * maxLen) / (q.length + t.length);
  return ratio >= threshold ? ratio : 0;
}

function searchSkills(
  index: any,
  keywords: string[],
  category: string | null = null,
  limit: number = 50
): { results: any[]; total: number } {
  if (!keywords || keywords.length === 0) return { results: [], total: 0 };

  const query = keywords.join(" ").trim();
  if (!query) return { results: [], total: 0 };

  const results: any[] = [];
  for (const skill of index.skills ?? []) {
    if (category && skill.category !== category) continue;

    const titleScore = fuzzyMatch(query, skill.title ?? "");
    const descScore = fuzzyMatch(query, skill.description ?? "") * 0.8;
    const tagScores = (skill.tags ?? []).map((t: string) => fuzzyMatch(query, t) * 0.7);
    const contentScore = fuzzyMatch(query, (skill.content ?? "").slice(0, 2000)) * 0.5;
    const score = Math.max(
      titleScore,
      descScore,
      tagScores.length > 0 ? Math.max(...tagScores) : 0,
      contentScore
    );

    if (score <= 0) continue;

    results.push({
      skill_id: skill.skill_id,
      title: skill.title,
      description: skill.description,
      category: skill.category,
      tags: skill.tags,
      file_path: skill.file_path,
      skill_dir: skill.skill_dir ?? "",
      score: Math.round(score * 1000) / 1000,
    });
  }

  results.sort((a, b) => b.score - a.score);
  const total = results.length;
  return { results: results.slice(0, limit), total };
}

// ============================================================
// LLM 精排
// ============================================================

async function recommendSkills(
  agent: Agent,
  index: any,
  query: string,
  keywords: string[],
  topK: number = 10
): Promise<any> {
  if (!keywords || keywords.length === 0) {
    return { skills: [], total: 0, error: "keywords 为空" };
  }

  const { results: candidates } = searchSkills(index, keywords, null, 30);
  if (candidates.length === 0) {
    return { skills: [], total: 0 };
  }

  const briefs = candidates.map((s) => ({
    skill_id: s.skill_id,
    title: s.title,
    description: (s.description ?? "").slice(0, 200),
    tags: (s.tags ?? []).slice(0, 5),
    score: s.score,
  }));

  const systemPrompt =
    "你是一个技能推荐专家。用户提出问题并给出关键词，你需要从候选技能中选出最匹配的。\n" +
    "候选技能已经经过初步关键词筛选，你只需要做语义精排。\n" +
    '返回JSON格式：{"skills": [{"skill_id": "xxx", "reason": "推荐理由"}]}\n' +
    "只返回最相关的 top_k 个，按相关度从高到低排序。";

  const userPrompt =
    `用户问题：${query}\n` +
    `关键词：${keywords.join(", ")}\n` +
    `返回数量：${topK}\n` +
    `候选技能（共${briefs.length}个）：\n` +
    JSON.stringify(briefs);

  try {
    if (!agent.llm) throw new Error("LLM 未配置");
    const result = await agent.llm.chat_json(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      undefined,
      "code"
    );
    const ranked = Array.isArray(result?.skills) ? result.skills : [];
    return { skills: ranked.slice(0, topK), total: ranked.length };
  } catch (e: any) {
    const fallback = candidates.slice(0, topK);
    return {
      skills: fallback.map((s) => ({
        skill_id: s.skill_id,
        reason: "关键词匹配（LLM降级）",
      })),
      total: fallback.length,
      error: e?.message ?? String(e),
    };
  }
}

// ============================================================
// 活跃技能读写
// ============================================================

function getActiveSkillFile(sessionId: string): string {
  return join(ACTIVE_SKILL_DIR, `${sessionId}_skill.txt`);
}

async function loadActiveSkill(sessionId: string): Promise<string> {
  const file = getActiveSkillFile(sessionId);
  if (!existsSync(file)) return "";
  try {
    return (await readFile(file, "utf-8")).trim();
  } catch {
    return "";
  }
}

async function saveActiveSkill(sessionId: string, content: string): Promise<void> {
  await mkdir(ACTIVE_SKILL_DIR, { recursive: true });
  await writeFile(getActiveSkillFile(sessionId), content, "utf-8");
}

async function clearActiveSkill(sessionId: string): Promise<void> {
  const file = getActiveSkillFile(sessionId);
  if (existsSync(file)) {
    const { rm } = await import("node:fs/promises");
    await rm(file, { force: true });
  }
}

// ============================================================
// 主入口
// ============================================================

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  let params = envelop.payload?.params ?? {};
  if (Object.keys(params).length === 0) {
    params = { ...envelop.payload };
  }

  const action = envelop.payload?.action ?? "list";
  const sessionId =
    envelop.meta?.session_id ??
    params.session_id ??
    "default";

  // ============================================================
  // 搜索类 action
  // ============================================================

  if (action === "scan") {
    const data = await scanSkills();
    envelop.payload = {
      ok: true,
      data: {
        total: data.skills.length,
        categories: data.categories,
        last_scan: data.last_scan,
        skipped: data.skipped ?? [],
      },
    };
    return envelop;
  }

  // ★ list：先 scan，再列
  if (action === "list") {
    await scanSkills();
    const freshIndex = await loadIndex();

    const category = params.category;
    const limit = params.limit ?? 100;
    const skills: any[] = [];
    for (const s of freshIndex.skills ?? []) {
      if (category && s.category !== category) continue;
      skills.push({
        skill_id: s.skill_id,
        title: s.title,
        description: s.description,
        category: s.category,
        tags: s.tags,
        file_path: s.file_path,
        skill_dir: s.skill_dir ?? "",
      });
      if (skills.length >= limit) break;
    }
    envelop.payload = {
      ok: true,
      data: {
        skills,
        total: skills.length,
        categories: freshIndex.categories,
        last_scan: freshIndex.last_scan,
      },
    };
    return envelop;
  }

  // ★ search：先 scan，再粗筛 + LLM 精排
  if (action === "search") {
    await scanSkills();
    const freshIndex = await loadIndex();

    const query = (params.query ?? "").trim();
    let keywords = params.keywords ?? [];
    if (typeof keywords === "string") keywords = keywords.trim() ? [keywords] : [];

    if (!query) {
      envelop.payload = { ok: false, error: "query 不能为空" };
      return envelop;
    }
    if (!Array.isArray(keywords) || keywords.length === 0) {
      envelop.payload = { ok: false, error: "keywords 不能为空" };
      return envelop;
    }

    const category = params.category ?? null;
    const limit = params.limit ?? 10;

    const { results: candidates } = searchSkills(freshIndex, keywords, category, 30);

    if (candidates.length === 0) {
      envelop.payload = {
        ok: true,
        data: { skills: [], total: 0, query, keywords },
      };
      return envelop;
    }

    const briefs = candidates.map((s) => ({
      skill_id: s.skill_id,
      title: s.title,
      description: (s.description ?? "").slice(0, 200),
      tags: (s.tags ?? []).slice(0, 5),
    }));

    const systemPrompt =
      "你是一个技能推荐专家。用户提出问题并给出关键词，你需要从候选技能中选出最匹配的。\n" +
      "候选技能已经经过初步关键词筛选，你只需要做语义精排。\n" +
      '返回JSON格式：{"skills": [{"skill_id": "xxx", "reason": "推荐理由"}]}\n' +
      "只返回最相关的 top_k 个，按相关度从高到低排序。";

    const userPrompt =
      `用户问题：${query}\n` +
      `关键词：${keywords.join(", ")}\n` +
      `返回数量：${limit}\n` +
      `候选技能（共${briefs.length}个）：\n` +
      JSON.stringify(briefs);

    try {
      if (!agent.llm) throw new Error("LLM 未配置");
      const result = await agent.llm.chat_json(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        undefined,
        "code"
      );
      const ranked = Array.isArray(result?.skills) ? result.skills : [];
      const finalSkills: any[] = [];
      for (const item of ranked.slice(0, limit)) {
        const skillId = item.skill_id;
        const detail = (freshIndex.skills ?? []).find((s: any) => s.skill_id === skillId);
        if (detail) {
          finalSkills.push({
            skill_id: detail.skill_id,
            title: detail.title,
            description: detail.description,
            category: detail.category,
            tags: detail.tags,
            file_path: detail.file_path,
            skill_dir: detail.skill_dir ?? "",
            reason: item.reason ?? "",
          });
        }
      }
      envelop.payload = {
        ok: true,
        data: { skills: finalSkills, total: finalSkills.length, query, keywords },
      };
    } catch (e: any) {
      const fallback = candidates.slice(0, limit);
      envelop.payload = {
        ok: true,
        data: {
          skills: fallback,
          total: fallback.length,
          query,
          keywords,
          fallback: true,
          error: e?.message ?? String(e),
        },
      };
    }
    return envelop;
  }

  // detail / categories / stats / 加载类 action 读 index，不主动 scan
  const index = await loadIndex();

  if (action === "detail") {
    const skillId = params.skill_id ?? "";
    const skill = (index.skills ?? []).find((s: any) => s.skill_id === skillId);
    if (!skill) {
      envelop.payload = { ok: false, error: "技能不存在" };
      return envelop;
    }
    envelop.payload = { ok: true, data: skill };
    return envelop;
  }

  if (action === "categories") {
    envelop.payload = {
      ok: true,
      data: {
        categories: index.categories ?? [],
        total: (index.categories ?? []).length,
      },
    };
    return envelop;
  }

  if (action === "stats") {
    const categoryCount: Record<string, number> = {};
    for (const s of index.skills ?? []) {
      categoryCount[s.category] = (categoryCount[s.category] ?? 0) + 1;
    }
    envelop.payload = {
      ok: true,
      data: {
        total_skills: (index.skills ?? []).length,
        total_categories: (index.categories ?? []).length,
        last_scan: index.last_scan,
        skipped: index.skipped ?? [],
        category_count: categoryCount,
      },
    };
    return envelop;
  }

  // ============================================================
  // 加载类 action
  // ============================================================

  if (action === "get_active") {
    const content = await loadActiveSkill(sessionId);
    envelop.payload = {
      ok: true,
      session_id: sessionId,
      content,
      size: content.length,
      has_skill: !!content,
    };
    return envelop;
  }

  if (action === "save_active") {
    const newContent =
      envelop.payload?.content ??
      params.content ??
      "";
    await saveActiveSkill(sessionId, newContent);
    envelop.payload = {
      ok: true,
      message: `✅ 已保存，${newContent.length} 字`,
      size: newContent.length,
    };
    return envelop;
  }

  if (action === "clear") {
    await clearActiveSkill(sessionId);
    envelop.payload = { ok: true, message: "✅ 技能已卸载", mode: "clear" };
    return envelop;
  }

  // ★ load：支持模糊匹配
  if (action === "load") {
    const skillId = params.skill_id ?? "";
    const mode = params.mode ?? "load";

    if (mode === "clear") {
      await clearActiveSkill(sessionId);
      envelop.payload = { ok: true, message: "✅ 技能已卸载", mode: "clear" };
      return envelop;
    }

    if (!skillId) {
      envelop.payload = { ok: false, error: "缺少 skill_id 参数" };
      return envelop;
    }

    // ★ 精确匹配
    let skill = (index.skills ?? []).find((s: any) => s.skill_id === skillId);

    // ★ 精确匹配失败 → 模糊匹配
    if (!skill) {
      const lower = skillId.toLowerCase();
      const candidates = (index.skills ?? []).filter((s: any) =>
        s.skill_id.toLowerCase().includes(lower) ||
        (s.skill_dir ?? "").toLowerCase().includes(lower) ||
        (s.file_path ?? "").toLowerCase().includes(lower)
      );

      if (candidates.length === 1) {
        skill = candidates[0];
        console.log(`[skill_loader] 模糊匹配: ${skillId} → ${skill.skill_id}`);
      } else if (candidates.length > 1) {
        envelop.payload = {
          ok: false,
          error: `skill_id "${skillId}" 匹配到多个技能，请用精确 ID`,
          candidates: candidates.map((s: any) => s.skill_id),
        };
        return envelop;
      }
    }

    if (!skill) {
      envelop.payload = { ok: false, error: `技能不存在: ${skillId}` };
      return envelop;
    }

    const content = skill.content ?? "";
    const title = skill.title ?? skillId;
    const skillDir = skill.skill_dir ?? "";
    const filePath = skill.file_path ?? "";

    if (!content) {
      envelop.payload = { ok: false, error: `技能 ${skillId} 内容为空` };
      return envelop;
    }

    let finalContent = content;
    if (skillDir) {
      const runtimeHeader =
        `<!-- ============================================ -->\n` +
        `<!-- 使用工具调用技能运行时信息 -->\n` +
        `<!-- 技能目录: ${skillDir} -->\n` +
        `<!-- 技能文件: ${filePath} -->\n` +
        `<!-- 本技能中所有相对路径（如 scripts/xxx.py、editing.md） -->\n` +
        `<!-- 均相对于上述技能目录。 -->\n` +
        `<!-- 使用绝对路径拼接。 -->\n` +
        `<!-- ============================================ -->\n\n`;
      finalContent = runtimeHeader + content;
    }

    await saveActiveSkill(sessionId, finalContent);

    envelop.payload = {
      ok: true,
      message: `✅ 技能已加载：${title}，${finalContent.length} 字`,
      skill_id: skill.skill_id,       // ★ 返回实际使用的 skill_id
      title,
      skill_dir: skillDir,
      size: finalContent.length,
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
    route: "builtins/tools/skill_loader",
    description: "技能加载器 — 搜索 / 加载 / 管理技能",
    input: {
      action: "scan | list | search | detail | categories | stats | load | clear | get_active | save_active",
      query: "搜索问题（search 时）",
      keywords: "关键词列表（search 时，必填）",
      category: "分类筛选（list / search 时，可选）",
      limit: "返回数量（默认 10）",
      skill_id: "技能 ID（detail / load 时）",
      mode: "load / clear（load 时，默认 load）",
      content: "新内容（save_active 时）",
    },
    output: {
      ok: "是否成功",
      data: "结果数据",
      message: "结果消息",
    },
  };
}