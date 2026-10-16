/**
 * task_manager — 分身任务管理器
 *
 * 职责：
 * - 创建分身任务（sub_ session）
 * - 给已有分身发送消息（续跑/改进）
 * - 拼装所有 meta（session_id / callback_receiver / _task_id）
 * - 接收回调，匹配 task_id，更新状态
 * - 提供 list / status / collect 查询
 * - 通知 main_agent 有新进展
 *
 * LLM 只传 description 和 task（或 task_id 和 message），其余全部由本模块处理。
 */

import { readFile, writeFile, mkdir, rename, unlink, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Envelop } from "../../../core/Envelop.js";
import type { Agent } from "../../../core/Agent.js";

// ============================================================
// 常量
// ============================================================

const TASKS_DIR = "data/memories/main_agent/tasks";
const FLOWS_BASE = "data/memories/main_agent/flows";
const MAX_CONCURRENT_TASKS = 5;
const TASK_TIMEOUT_SECONDS = 600;

// ============================================================
// 存储
// ============================================================

function tasksFile(parentSession: string): string {
  return join(TASKS_DIR, `${parentSession}.json`);
}

async function loadTasks(parentSession: string): Promise<Record<string, any>> {
  const f = tasksFile(parentSession);
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(await readFile(f, "utf-8"));
  } catch {
    return {};
  }
}

async function saveTasks(parentSession: string, tasks: any): Promise<void> {
  const f = tasksFile(parentSession);
  await mkdir(TASKS_DIR, { recursive: true });
  const tmp = `${f}.tmp`;
  await writeFile(tmp, JSON.stringify(tasks, null, 2), "utf-8");
  await rename(tmp, f);
}

function now(): string {
  return new Date().toISOString();
}

async function updateTask(
  parentSession: string,
  taskId: string,
  patch: any
): Promise<boolean> {
  const tasks = await loadTasks(parentSession);
  if (!(taskId in tasks)) return false;
  tasks[taskId] = { ...tasks[taskId], ...patch };
  await saveTasks(parentSession, tasks);
  return true;
}

async function countRunning(parentSession: string): Promise<number> {
  const tasks = await loadTasks(parentSession);
  return Object.values(tasks).filter((t: any) => t.status === "running").length;
}

async function checkTimeouts(parentSession: string): Promise<void> {
  const tasks = await loadTasks(parentSession);
  const nowDate = new Date();
  let changed = false;
  for (const tid of Object.keys(tasks)) {
    const t = tasks[tid];
    if (t.status !== "running") continue;
    try {
      const created = new Date(t.created_at);
      if ((nowDate.getTime() - created.getTime()) / 1000 > TASK_TIMEOUT_SECONDS) {
        t.status = "timeout";
        t.error = `任务超过 ${TASK_TIMEOUT_SECONDS} 秒未完成`;
        t.finished_at = now();
        changed = true;
      }
    } catch {
      // ignore
    }
  }
  if (changed) {
    await saveTasks(parentSession, tasks);
  }
}

async function formatSummary(parentSession: string): Promise<string> {
  const tasks = await loadTasks(parentSession);
  if (Object.keys(tasks).length === 0) return "";
  const lines = ["【分身任务】"];
  const sorted = Object.entries(tasks).sort((a, b) =>
    String((a[1] as any).created_at ?? "").localeCompare(String((b[1] as any).created_at ?? ""))
  );
  for (const [tid, t] of sorted) {
    const status = (t as any).status ?? "unknown";
    const icon: Record<string, string> = {
      running: "⏳",
      done: "✅",
      failed: "❌",
      timeout: "⏰",
      cancelled: "🚫",
    };
    const iconStr = icon[status] ?? "?";
    const desc = (t as any).description ?? "";
    lines.push(`${iconStr} ${tid}: ${desc} [${status}]`);
  }
  return lines.join("\n");
}

/**
 * 删除指定的 flow 文件，返回删除数量
 */
async function deleteFlowFiles(taskIds: string[]): Promise<number> {
  let deleted = 0;
  if (!existsSync(FLOWS_BASE)) return 0;

  let dateDirs: string[];
  try {
    dateDirs = await readdir(FLOWS_BASE);
  } catch {
    return 0;
  }

  for (const dateDir of dateDirs) {
    const dirPath = join(FLOWS_BASE, dateDir);
    try {
      const s = await stat(dirPath);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }

    for (const tid of taskIds) {
      const flowFile = join(dirPath, `${tid}.json`);
      if (existsSync(flowFile)) {
        try {
          await unlink(flowFile);
          deleted++;
        } catch {
          // ignore
        }
      }
    }
  }

  return deleted;
}

// ============================================================
// action 处理器
// ============================================================

async function handleCreate(
  agent: Agent,
  params: any,
  sessionId: string
): Promise<any> {
  const description = (params.description ?? "").trim();
  const taskText = (params.task ?? "").trim();

  if (!description || !taskText) {
    return { ok: false, think: "缺少 description 或 task" };
  }

  if ((await countRunning(sessionId)) >= MAX_CONCURRENT_TASKS) {
    return {
      ok: false,
      think: `并发任务已达上限（${MAX_CONCURRENT_TASKS}）。请等现有任务完成，或用 task_manager.list 查看。`,
    };
  }

  const taskId = `sub_${randomHex(8)}`;

  const tasks = await loadTasks(sessionId);
  tasks[taskId] = {
    task_id: taskId,
    parent_session: sessionId,
    description,
    task: taskText,
    status: "running",
    created_at: now(),
    finished_at: null,
    result: null,
    error: null,
  };
  await saveTasks(sessionId, tasks);

  const callMeta = {
    session_id: sessionId,
    callback_receiver: "builtins/tools/task_manager",
    callback_session_id: sessionId,
    _task_id: taskId,
  };

  try {
    await agent.system.call(new Envelop({
      sender: "builtins/tools/task_manager",
      receiver: "builtins/agents/main_agent",
      payload: {
        content: taskText,
        session_id: taskId,
        action: "chat",
      },
      meta: callMeta,
    }));
  } catch (e: any) {
    await updateTask(sessionId, taskId, {
      status: "failed",
      error: `创建分身失败: ${e?.message ?? e}`,
      finished_at: now(),
    });
    return { ok: false, think: `创建分身失败: ${e?.message ?? e}` };
  }

  return {
    ok: true,
    think: `✅ 分身任务已创建：${taskId}（${description}），正在后台执行，完成后会自动回调。不要重复创建，等待【分身任务】摘要更新或回调结果。`,
    data: {
      task_id: taskId,
      description,
      status: "running",
    },
    _summary: await formatSummary(sessionId),
  };
}

async function handleSend(
  agent: Agent,
  params: any,
  sessionId: string
): Promise<any> {
  const taskId = (params.task_id ?? "").trim();
  const message = (params.message ?? "").trim();

  if (!taskId || !message) {
    return { ok: false, think: "缺少 task_id 或 message" };
  }

  const tasks = await loadTasks(sessionId);
  const t = tasks[taskId];
  if (!t) return { ok: false, think: `任务不存在: ${taskId}` };

  // 状态改回 running
  await updateTask(sessionId, taskId, {
    status: "running",
    finished_at: null,
    error: null,
  });

  const callMeta = {
    session_id: sessionId,
    callback_receiver: "builtins/tools/task_manager",
    callback_session_id: sessionId,
    _task_id: taskId,
  };

  try {
    await agent.system.call(new Envelop({
      sender: "builtins/tools/task_manager",
      receiver: "builtins/agents/main_agent",
      payload: {
        content: message,
        session_id: taskId,     // ★ 复用已有的 session
        action: "chat",
      },
      meta: callMeta,
    }));
  } catch (e: any) {
    await updateTask(sessionId, taskId, {
      status: "failed",
      error: `发送失败: ${e?.message ?? e}`,
      finished_at: now(),
    });
    return { ok: false, think: `发送失败: ${e?.message ?? e}` };
  }

  return {
    ok: true,
    think: `✅ 已发送到 ${taskId}，分身将带着记忆继续，完成后自动回调。不要轮询。`,
    data: {
      task_id: taskId,
      status: "running",
    },
    _summary: await formatSummary(sessionId),
  };
}

async function handleList(
  agent: Agent,
  params: any,
  sessionId: string
): Promise<any> {
  await checkTimeouts(sessionId);
  const tasks = await loadTasks(sessionId);
  const statusFilter = params.status ?? "";

  const result: any[] = [];
  for (const [tid, t] of Object.entries(tasks)) {
    const tt = t as any;
    if (statusFilter && tt.status !== statusFilter) continue;
    result.push({
      task_id: tid,
      description: tt.description ?? "",
      status: tt.status ?? "",
      created_at: tt.created_at,
      finished_at: tt.finished_at,
    });
  }

  return {
    ok: true,
    think: `共 ${result.length} 个任务`,
    data: {
      tasks: result,
      running_count: await countRunning(sessionId),
      max_concurrent: MAX_CONCURRENT_TASKS,
    },
    _summary: await formatSummary(sessionId),
  };
}

async function handleStatus(
  agent: Agent,
  params: any,
  sessionId: string
): Promise<any> {
  const taskId = params.task_id ?? "";
  if (!taskId) return { ok: false, think: "缺少 task_id" };

  const tasks = await loadTasks(sessionId);
  const t = tasks[taskId];
  if (!t) return { ok: false, think: `任务不存在: ${taskId}` };

  return {
    ok: true,
    think: `任务 ${taskId} 状态: ${t.status}`,
    data: t,
  };
}

async function handleCancel(
  agent: Agent,
  params: any,
  sessionId: string
): Promise<any> {
  const taskId = params.task_id ?? "";
  if (!taskId) return { ok: false, think: "缺少 task_id" };

  const tasks = await loadTasks(sessionId);
  const t = tasks[taskId];
  if (!t) return { ok: false, think: `任务不存在: ${taskId}` };

  if (t.status !== "running") {
    return { ok: false, think: `任务 ${taskId} 已结束（${t.status}），无法取消` };
  }

  await updateTask(sessionId, taskId, {
    status: "cancelled",
    error: "被调用方取消",
    finished_at: now(),
  });

  return {
    ok: true,
    think: `任务 ${taskId} 已标记取消`,
    data: { task_id: taskId },
    _summary: await formatSummary(sessionId),
  };
}

async function handleCollect(
  agent: Agent,
  params: any,
  sessionId: string
): Promise<any> {
  const taskId = params.task_id ?? "";
  const wait = params.wait === true;
  const timeout = Number(params.timeout ?? 60);

  if (taskId) {
    await checkTimeouts(sessionId);
    const tasks = await loadTasks(sessionId);
    const t = tasks[taskId];
    if (!t) return { ok: false, think: `任务不存在: ${taskId}` };
    return {
      ok: true,
      think: `任务 ${taskId} 状态: ${t.status}`,
      data: {
        task_id: taskId,
        description: t.description ?? "",
        status: t.status,
        result: t.result,
        error: t.error,
        created_at: t.created_at,
        finished_at: t.finished_at,
      },
      _summary: await formatSummary(sessionId),
    };
  }

  await checkTimeouts(sessionId);

  if (wait) {
    const start = Date.now();
    while (true) {
      if ((await countRunning(sessionId)) === 0) break;
      if ((Date.now() - start) / 1000 >= timeout) break;
      await new Promise((r) => setTimeout(r, 500));
      await checkTimeouts(sessionId);
    }
  }

  const tasks = await loadTasks(sessionId);
  const done: any = {};
  const running: any = {};
  const failed: any = {};

  for (const [tid, t] of Object.entries(tasks)) {
    const tt = t as any;
    if (tt.status === "done") {
      done[tid] = { description: tt.description ?? "", result: tt.result };
    } else if (tt.status === "running") {
      running[tid] = tt.description ?? "";
    } else {
      failed[tid] = {
        description: tt.description ?? "",
        status: tt.status,
        error: tt.error,
      };
    }
  }

  return {
    ok: true,
    think: `完成 ${Object.keys(done).length} / 运行中 ${Object.keys(running).length} / 失败 ${Object.keys(failed).length}`,
    data: { done, running, failed },
    _summary: await formatSummary(sessionId),
  };
}

async function handleClear(
  agent: Agent,
  params: any,
  sessionId: string
): Promise<any> {
  const tasks = await loadTasks(sessionId);
  const kept: any = {};
  const removedTids: string[] = [];

  for (const [tid, t] of Object.entries(tasks)) {
    const status = (t as any).status;
    if (status === "running" || status === "pending") {
      kept[tid] = t;
    } else {
      removedTids.push(tid);
    }
  }

  const removed = removedTids.length;
  await saveTasks(sessionId, kept);

  // ★ 删除已结束分身的 flow 文件
  const deletedFlows = await deleteFlowFiles(removedTids);

  // 推送前端刷新
  try {
    await agent.system.call(new Envelop({
      sender: "builtins/tools/task_manager",
      receiver: "os/_websocket",
      payload: {
        action: "push",
        channel_id: `pa_${sessionId}`,
        data: {
          type: "progress",
          step: "done",
          msg: `清理分身：${removed} 个记录，${deletedFlows} 个 flow`,
          agent_type: "task_manager",
        },
      },
    }));
  } catch {
    // ignore
  }

  return {
    ok: true,
    think: `已清空 ${removed} 个已结束任务（含 ${deletedFlows} 个 flow 文件）`,
    data: {
      removed,
      deleted_flows: deletedFlows,
      kept: Object.keys(kept).length,
    },
    _summary: await formatSummary(sessionId),
  };
}

async function handleDelete(
  agent: Agent,
  params: any,
  sessionId: string
): Promise<any> {
  let taskIds: string[] = params.task_ids ?? [];

  // 兼容单个 task_id
  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    const single = (params.task_id ?? "").trim();
    if (single) {
      taskIds = [single];
    }
  }

  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    return { ok: false, think: "缺少 task_ids 或 task_id" };
  }

  const tasks = await loadTasks(sessionId);
  const deleted: string[] = [];
  const skipped: any[] = [];

  for (const rawTid of taskIds) {
    const tid = String(rawTid).trim();
    if (!tid) continue;

    if (!(tid in tasks)) {
      skipped.push({ task_id: tid, reason: "不存在" });
      continue;
    }

    if (tasks[tid].status === "running") {
      skipped.push({ task_id: tid, reason: "正在运行，请先 cancel" });
      continue;
    }

    delete tasks[tid];
    deleted.push(tid);
  }

  await saveTasks(sessionId, tasks);

  // ★ 删除对应的 flow 文件
  const deletedFlows = await deleteFlowFiles(deleted);

  // 推送前端刷新
  try {
    await agent.system.call(new Envelop({
      sender: "builtins/tools/task_manager",
      receiver: "os/_websocket",
      payload: {
        action: "push",
        channel_id: `pa_${sessionId}`,
        data: {
          type: "progress",
          step: "done",
          msg: `删除分身：${deleted.length} 个记录，${deletedFlows} 个 flow`,
          agent_type: "task_manager",
        },
      },
    }));
  } catch {
    // ignore
  }

  return {
    ok: true,
    think: `已删除 ${deleted.length} 个分身（含 ${deletedFlows} 个 flow 文件）`,
    data: {
      deleted,
      deleted_flows: deletedFlows,
      skipped,
    },
    _summary: await formatSummary(sessionId),
  };
}

// ============================================================
// 回调处理
// ============================================================

async function handleCallback(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const meta = envelop.meta ?? {};
  const taskId = meta._task_id ?? "";
  const parentSession = meta.callback_session_id ?? "";

  if (!taskId || !parentSession) return envelop;

  const payload = envelop.payload ?? {};
  const pluginOk = payload.ok ?? true;
  const error = payload.error ?? "";

  const patch = {
    status: pluginOk ? "done" : "failed",
    finished_at: now(),
    result: payload,
    error: error || null,
  };
  await updateTask(parentSession, taskId, patch);

  // 通知 main_agent 继续推理
  try {
    await agent.system.call(new Envelop({
      sender: "builtins/tools/task_manager",
      receiver: "builtins/agents/main_agent",
      payload: { content: "", action: "" },
      meta: {
        session_id: parentSession,
        is_callback: true,
        callback_session_id: parentSession,
        _task_id: taskId,
        _task_summary: await formatSummary(parentSession),
        _task_result: payload,
      },
    }));
  } catch {
    // ignore
  }

  return envelop;
}

// ============================================================
// 主入口
// ============================================================

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  // 回调优先
  if (envelop.meta?.is_callback) {
    return await handleCallback(envelop, agent);
  }

  let params = envelop.payload?.params ?? {};
  if (Object.keys(params).length === 0) {
    params = { ...envelop.payload };
  }

  const action = envelop.payload?.action ?? "list";
  const sessionId = envelop.meta?.session_id ?? "default";

  // 分身不能再使用 task_manager
  if (sessionId.startsWith("sub_")) {
    envelop.payload = {
      ok: false,
      error: "分身不能再使用 task_manager（避免无限嵌套）。请直接在当前执行线上完成任务。",
    };
    return envelop;
  }

  const handlers: Record<string, (a: Agent, p: any, s: string) => Promise<any>> = {
    create: handleCreate,
    send: handleSend,
    list: handleList,
    status: handleStatus,
    cancel: handleCancel,
    collect: handleCollect,
    clear: handleClear,
    delete: handleDelete,
  };

  const handler = handlers[action];
  if (!handler) {
    envelop.payload = { ok: false, error: `未知 action: ${action}` };
    return envelop;
  }

  let result: any;
  try {
    result = await handler(agent, params, sessionId);
  } catch (e: any) {
    envelop.payload = { ok: false, error: `task_manager 异常: ${e?.message ?? e}` };
    return envelop;
  }

  const summary = result._summary;
  delete result._summary;

  envelop.payload = {
    ok: result.ok ?? false,
    data: result.data ?? {},
    message: result.think ?? "",
  };
  if (summary) {
    envelop.payload.data._summary = summary;
  }

  return envelop;
}

// ============================================================
// 工具
// ============================================================

function randomHex(n: number): string {
  const bytes = new Uint8Array(Math.ceil(n / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, n);
}

// ============================================================
// help
// ============================================================

export function help() {
  return {
    route: "builtins/tools/task_manager",
    description: "分身任务管理器 —— 创建、追踪、续跑、收集、清理并行子任务",
    input: {
      action: "create | send | list | status | cancel | collect | clear | delete",
      description: "任务简述（create 时）",
      task: "完整任务描述（create 时）",
      task_id: "任务 ID（send / status / cancel / delete 时）",
      message: "要发送的消息（send 时）",
      task_ids: "任务 ID 列表（delete 时，支持批量）",
      status: "筛选状态（list 时）",
      wait: "是否等待（collect 时）",
      timeout: "等待超时秒数（collect 时）",
    },
    output: {
      ok: "是否成功",
      data: "任务数据",
      message: "结果消息",
    },
  };
}
