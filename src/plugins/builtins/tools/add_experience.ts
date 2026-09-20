/**
 * add_experience — 沉淀经验到背包（带归并保护）
 *
 * 统一 action 模式：
 * - append：直接拼接
 * - replace：走归并 LLM（保留旧内容，合并新内容）
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Envelop } from "../../../core/Envelop.js";
import type { Agent } from "../../../core/Agent.js";

// ============================================================
// 路径
// ============================================================

const MEMORY_DIR = "data/memories/main_agent";
const EXPERIENCE_DIR = join(MEMORY_DIR, "experiences");
const HISTORY_DIR = join(EXPERIENCE_DIR, "history");

function getExperienceFile(sessionId: string): string {
  return join(EXPERIENCE_DIR, `${sessionId}_backpack.txt`);
}

async function loadExperience(sessionId: string): Promise<string> {
  const file = getExperienceFile(sessionId);
  if (!existsSync(file)) return "";
  const content = await readFile(file, "utf-8");
  return content.trim();
}

async function saveExperience(sessionId: string, content: string): Promise<void> {
  await mkdir(EXPERIENCE_DIR, { recursive: true });
  const file = getExperienceFile(sessionId);
  await writeFile(file, content, "utf-8");
}

async function backupExperience(sessionId: string, content: string): Promise<string> {
  if (!content) return "";
  await mkdir(HISTORY_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const revision = `${sessionId}_${ts}`;
  await writeFile(join(HISTORY_DIR, `${revision}.txt`), content, "utf-8");
  return revision;
}

// ============================================================
// 归并 LLM
// ============================================================

const MERGE_SYSTEM_PROMPT = `你是经验背包的归并器（Experience Backpack Merger）。

你的唯一职责：把主 agent 提交的新版本，安全地归并进当前背包。

规则：
1. 以【当前背包】为基础，把【新版本】里真正的新增、修正合并进去。
2. 保留当前背包里未被新版本触及的内容。
3. 除非新版本明确表示某条已废弃，否则不要删除当前背包里的内容。
4. 如果新版本只是换了措辞但语义相同，保留更清晰、更完整的版本。
5. 如果新版本和当前背包内容完全重复，去重。
6. 保持原有格式风格（段落、标题、编号），不要强行重排结构。
7. 不要输出任何解释、前言、后记。

只输出归并后的完整背包正文。`;

async function mergeWithLLM(
  current: string,
  proposed: string,
  agent: Agent
): Promise<string> {
  const userPrompt = `【当前背包】\n${current}\n\n【主 agent 提交的新版本】\n${proposed}`;

  try {
    if (!agent.llm) {
      throw new Error("LLM not available");
    }

    const merged = await agent.llm.chat([
      { role: "system", content: MERGE_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ]);

    const trimmed = (merged || "").trim();
    if (!trimmed) {
      throw new Error("归并结果为空");
    }

    // 检测 LLM 错误包装
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      throw new Error(`LLM 返回错误: ${trimmed.slice(0, 100)}`);
    }

    return trimmed;
  } catch (e: any) {
    console.warn(`[add_experience] 归并失败，回退保守合并: ${e.message}`);
    if (current && proposed) {
      return `${current}\n\n${proposed}`;
    }
    return current || proposed;
  }
}

// ============================================================
// 主入口
// ============================================================

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  // 统一 action 模式
  const action = envelop.payload?.action ?? "append";

  // 兼容两种传参：payload.params.xxx 或 payload.xxx
  let params = envelop.payload?.params ?? {};
  if (Object.keys(params).length === 0) {
    params = { ...envelop.payload };
  }

  const sessionId =
    params.session_id ??
    envelop.meta?.session_id ??
    "default";
  const experience = params.experience ?? "";

  // action 校验
  if (action !== "append" && action !== "replace") {
    envelop.payload = { ok: false, error: `未知 action: ${action}` };
    return envelop;
  }

  if (!experience) {
    envelop.payload = { ok: false, error: "缺少 experience 参数" };
    return envelop;
  }

  try {
    const current = await loadExperience(sessionId);

    let revision = "";
    let diffSummary = "";
    let newContent: string;

    if (action === "replace") {
      if (current) {
        revision = await backupExperience(sessionId, current);
        newContent = await mergeWithLLM(current, experience, agent);

        if (newContent === current) {
          diffSummary = "无实质变化";
        } else if (newContent.includes(experience)) {
          diffSummary = "已归并新版本，保留原有经验";
        } else {
          diffSummary = "已归并，内容有调整";
        }
      } else {
        newContent = experience;
        diffSummary = "首次写入";
      }
    } else {
      // append
      newContent = current ? `${current}\n${experience}` : experience;
      diffSummary = "追加";
    }

    await saveExperience(sessionId, newContent);

    envelop.payload = {
      ok: true,
      message: `✅ 经验已${action === "replace" ? "归并更新" : "追加"}，当前背包 ${newContent.length} 字`,
      action,
      size: newContent.length,
      revision,
      diff: diffSummary,
    };
    return envelop;
  } catch (e: any) {
    envelop.payload = { ok: false, error: `保存经验失败: ${e.message}` };
    return envelop;
  }
}

// ============================================================
// help
// ============================================================

export function help() {
  return {
    route: "builtins/tools/add_experience",
    description: "沉淀经验到经验背包",
    input: {
      action: "append / replace（可选，默认 append）",
      experience: "经验内容",
      session_id: "会话 ID（可选，默认从 meta 取或 'default'）",
    },
    output: {
      ok: "是否成功",
      message: "结果消息",
      action: "使用的 action",
      size: "背包大小",
      revision: "归并版本号（replace 时）",
      diff: "变更摘要（replace 时）",
    },
  };
}