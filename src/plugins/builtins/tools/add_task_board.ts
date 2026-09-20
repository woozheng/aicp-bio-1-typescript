/**
 * add_task_board — 更新当前任务看板
 *
 * 统一 action 模式：
 * - replace：覆盖（默认）
 * - append：追加
 * - clear：清空
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
const TASKBOARD_DIR = join(MEMORY_DIR, "taskboards");

function getTaskboardFile(sessionId: string): string {
  return join(TASKBOARD_DIR, `${sessionId}_taskboard.txt`);
}

async function loadTaskboard(sessionId: string): Promise<string> {
  const file = getTaskboardFile(sessionId);
  if (!existsSync(file)) return "";
  const content = await readFile(file, "utf-8");
  return content.trim();
}

async function saveTaskboard(sessionId: string, content: string): Promise<void> {
  await mkdir(TASKBOARD_DIR, { recursive: true });
  await writeFile(getTaskboardFile(sessionId), content, "utf-8");
}

// ============================================================
// 主入口
// ============================================================

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  // 统一 action 模式
  const action = envelop.payload?.action ?? "replace";

  // 兼容两种传参：payload.params.xxx 或 payload.xxx
  let params = envelop.payload?.params ?? {};
  if (Object.keys(params).length === 0) {
    params = { ...envelop.payload };
  }

  const sessionId = envelop.meta?.session_id ?? "default";
  const content = params.content ?? "";

  // action 校验
  if (action !== "replace" && action !== "append" && action !== "clear") {
    envelop.payload = { ok: false, error: `未知 action: ${action}` };
    return envelop;
  }

  // clear：不需要 content
  if (action === "clear") {
    try {
      await saveTaskboard(sessionId, "");
      envelop.payload = {
        ok: true,
        message: "✅ 任务看板已清空",
        action: "clear",
        size: 0,
      };
      return envelop;
    } catch (e: any) {
      envelop.payload = { ok: false, error: `保存任务看板失败: ${e.message}` };
      return envelop;
    }
  }

  if (!content) {
    envelop.payload = { ok: false, error: "缺少 content 参数" };
    return envelop;
  }

  try {
    const current = await loadTaskboard(sessionId);

    let newContent: string;
    if (action === "append") {
      newContent = current ? `${current}\n${content}` : content;
    } else {
      newContent = content;
    }

    await saveTaskboard(sessionId, newContent);

    envelop.payload = {
      ok: true,
      message: `✅ 任务看板已${action === "append" ? "追加" : "更新"}，当前 ${newContent.length} 字`,
      action,
      size: newContent.length,
    };
    return envelop;
  } catch (e: any) {
    envelop.payload = { ok: false, error: `保存任务看板失败: ${e.message}` };
    return envelop;
  }
}

// ============================================================
// help
// ============================================================

export function help() {
  return {
    route: "builtins/tools/add_task_board",
    description: "更新当前任务看板（记录当前任务进度和上下文）",
    input: {
      action: "replace / append / clear（可选，默认 replace）",
      content: "任务看板内容（纯文本，clear 时不需要）",
    },
    output: {
      ok: "是否成功",
      message: "结果消息",
      action: "使用的 action",
      size: "看板大小",
    },
  };
}