/**
 * 定时任务插件 — 协议 v3.0 系统插件
 *
 * 接口对齐：os/_cron schedule/update/cancel/list
 * 入参：interval(秒) / at_time("HH:MM")，同时提供 at_time 优先
 *
 * 与 Python 版 os/_cron.py 对应。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Envelop } from "../../core/Envelop.js";
import type { Agent } from "../../core/Agent.js";

const DATA_DIR = "data/os_cron";
const TASKS_FILE = join(DATA_DIR, "tasks.json");

interface TaskConfig {
  interval?: number;
  at_time?: string;
  target_receiver: string;
  target_payload: Record<string, any>;
  token?: string;
  immediate?: boolean;
}

const _tasks: Map<string, { stop: boolean }> = new Map();
let _persistedTasks: Record<string, TaskConfig> = {};

// ============================================================
// 持久化
// ============================================================

async function loadPersistedTasks(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(TASKS_FILE)) {
    _persistedTasks = {};
    return;
  }
  try {
    const raw = await readFile(TASKS_FILE, "utf-8");
    _persistedTasks = JSON.parse(raw);
  } catch {
    _persistedTasks = {};
  }
}

async function savePersistedTasks(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(TASKS_FILE, JSON.stringify(_persistedTasks, null, 2), "utf-8");
}

// ============================================================
// 时间解析
// ============================================================

function parseAtTime(atTime: string): [number, number] {
  const [hh, mm] = atTime.trim().split(":");
  return [parseInt(hh, 10), parseInt(mm, 10)];
}

function getNextDailyTs(atTime: string): number {
  const [hour, minute] = parseAtTime(atTime);
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

function formatHeartbeatContent(content: string): string {
  if (!content) return content;
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const prefix = `【心跳唤醒 ${timestamp}】`;
  if (content.startsWith("【心跳唤醒")) {
    const endIdx = content.indexOf("】");
    if (endIdx !== -1) {
      return `【心跳唤醒 ${timestamp}】${content.slice(endIdx + 1)}`;
    }
  }
  return `${prefix}${content}`;
}

// ============================================================
// 调度循环
// ============================================================

async function startCronLoop(
  taskId: string,
  config: TaskConfig,
  agent: Agent
): Promise<void> {
  const atTime = config.at_time;
  const interval = config.interval;
  const targetReceiver = config.target_receiver;
  const targetPayload = config.target_payload;
  const immediate = config.immediate ?? false;

  const scheduleMode = atTime ? "daily" : "interval";

  const state = { stop: false };
  _tasks.set(taskId, state);

  const loop = async () => {
    let nextRunTime: number;

    if (scheduleMode === "daily") {
      try {
        nextRunTime = getNextDailyTs(atTime!);
      } catch (e: any) {
        agent.log?.error?.(`Cron ${taskId} parse at_time error: ${e.message}`);
        return;
      }
    } else {
      nextRunTime = Date.now();
    }

    if (immediate) {
      try {
        const payload = { ...targetPayload };
        if (payload.content) {
          payload.content = formatHeartbeatContent(payload.content);
        }
        await agent.system.call(new Envelop({
          sender: "os/_cron",
          receiver: targetReceiver,
          payload,
        }));
      } catch (e: any) {
        agent.log?.error?.(`Cron ${taskId} immediate exec error: ${e.message}`);
      }

      if (scheduleMode === "daily") {
        try {
          nextRunTime = getNextDailyTs(atTime!);
        } catch {
          return;
        }
      } else {
        nextRunTime += (interval ?? 0) * 1000;
      }
    } else {
      if (scheduleMode === "interval") {
        nextRunTime += (interval ?? 0) * 1000;
      }
    }

    while (_tasks.has(taskId) && !state.stop) {
      const now = Date.now();
      let sleepTime = nextRunTime - now;

      const jumpThreshold = scheduleMode === "interval"
        ? (interval ?? 0) * 2 * 1000
        : 600 * 1000;

      if (sleepTime < -jumpThreshold) {
        agent.log?.warn?.(`Cron ${taskId}: 检测到系统休眠时间跳变，重新计算调度时刻`);
        if (scheduleMode === "daily") {
          try {
            nextRunTime = getNextDailyTs(atTime!);
          } catch {
            break;
          }
        } else {
          nextRunTime = Date.now() + (interval ?? 0) * 1000;
        }
        sleepTime = nextRunTime - Date.now();
      }

      if (sleepTime > 0) {
        await sleepInterruptible(sleepTime, state);
        if (state.stop) break;
      }

      if (!_tasks.has(taskId) || state.stop) break;

      // 执行任务
      try {
        const payload = { ...targetPayload };
        if (payload.content) {
          payload.content = formatHeartbeatContent(payload.content);
        }
        await agent.system.call(new Envelop({
          sender: "os/_cron",
          receiver: targetReceiver,
          payload,
        }));
      } catch (e: any) {
        agent.log?.error?.(`Cron ${taskId}: ${e.message}`);
      }

      // 下一次
      if (scheduleMode === "daily") {
        try {
          nextRunTime = getNextDailyTs(atTime!);
        } catch {
          agent.log?.error?.(`Cron ${taskId}: at_time 解析失败，退出循环`);
          break;
        }
      } else {
        nextRunTime += (interval ?? 0) * 1000;
      }
    }

    _tasks.delete(taskId);
  };

  loop().catch((e) => {
    agent.log?.error?.(`Cron ${taskId} loop error: ${e.message}`);
    _tasks.delete(taskId);
  });
}

async function sleepInterruptible(ms: number, state: { stop: boolean }): Promise<void> {
  const interval = 100;
  const endTime = Date.now() + ms;
  while (Date.now() < endTime && !state.stop) {
    const remaining = Math.min(interval, endTime - Date.now());
    await new Promise((r) => setTimeout(r, remaining));
  }
}

// ============================================================
// 恢复
// ============================================================

async function restoreTasks(agent: Agent): Promise<void> {
  await loadPersistedTasks();
  for (const [taskId, config] of Object.entries(_persistedTasks)) {
    if (!_tasks.has(taskId)) {
      await startCronLoop(taskId, config, agent);
      agent.log?.info?.(`[os/_cron] 恢复任务: ${taskId}`);
    }
  }
}

// ============================================================
// 主入口
// ============================================================

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const action = envelop.payload.action ?? "";

  if (Object.keys(_persistedTasks).length === 0 && existsSync(TASKS_FILE)) {
    await restoreTasks(agent);
  }

  if (action === "schedule") return await schedule(envelop, agent);
  if (action === "update") return await update(envelop, agent);
  if (action === "cancel") return await cancel(envelop, agent);
  if (action === "list") return await list(envelop, agent);
  if (action === "restore") {
    await restoreTasks(agent);
    envelop.payload = { ok: true, restored: _tasks.size };
    return envelop;
  }

  envelop.payload = { ok: false, error: `Unknown action: ${action}` };
  return envelop;
}

// ============================================================
// schedule
// ============================================================

async function schedule(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const taskId = envelop.payload.task_id ?? "";
  let interval = envelop.payload.interval;
  const atTime = envelop.payload.at_time;
  const targetReceiver = envelop.payload.target_receiver ?? "";
  const targetPayload = envelop.payload.target_payload ?? {};
  const immediate = envelop.payload.immediate ?? false;
  const persisted = envelop.payload.persisted ?? true;

  if (!taskId) {
    envelop.payload = { ok: false, error: "task_id is required" };
    return envelop;
  }

  if (!targetReceiver) {
    envelop.payload = { ok: false, error: "target_receiver is required" };
    return envelop;
  }

  if (interval === undefined && atTime === undefined) {
    envelop.payload = { ok: false, error: "must provide interval (seconds) or at_time (HH:MM)" };
    return envelop;
  }

  if (!targetPayload.content) {
    envelop.payload = {
      ok: false,
      error: "target_payload must contain 'content' field",
      example: { session_id: "your_session_id", content: "【定时任务】执行具体操作描述" },
    };
    return envelop;
  }

  if (!targetPayload.session_id) {
    envelop.payload = {
      ok: false,
      error: "target_payload must contain 'session_id' field",
      example: { session_id: "your_session_id", content: "【定时任务】执行具体操作描述" },
    };
    return envelop;
  }

  if (atTime !== undefined) {
    try {
      parseAtTime(atTime);
    } catch {
      envelop.payload = { ok: false, error: `invalid at_time format: ${atTime}, expected HH:MM` };
      return envelop;
    }
  }

  if (interval !== undefined) {
    interval = parseInt(interval, 10);
    if (!Number.isFinite(interval) || interval <= 0) {
      envelop.payload = { ok: false, error: `invalid interval: ${interval}, must be positive integer` };
      return envelop;
    }
  }

  if (_tasks.has(taskId)) {
    envelop.payload = { ok: false, error: `task '${taskId}' already exists` };
    return envelop;
  }

  const token = envelop.meta.session_id ?? envelop.meta.token ?? "";
  if (!targetPayload.session_id) targetPayload.session_id = token;

  const taskConfig: TaskConfig = {
    interval,
    at_time: atTime,
    target_receiver: targetReceiver,
    target_payload: targetPayload,
    token,
    immediate,
  };

  if (persisted) {
    _persistedTasks[taskId] = taskConfig;
    await savePersistedTasks();
  }

  await startCronLoop(taskId, taskConfig, agent);

  const scheduleMode = atTime ? "daily" : "interval";
  envelop.payload = {
    ok: true,
    task_id: taskId,
    schedule_mode: scheduleMode,
    interval,
    at_time: atTime,
    immediate,
    persisted,
    target_receiver: targetReceiver,
  };
  return envelop;
}

// ============================================================
// update
// ============================================================

async function update(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const taskId = envelop.payload.task_id ?? "";
  const interval = envelop.payload.interval;
  const atTime = envelop.payload.at_time;
  const targetReceiver = envelop.payload.target_receiver;
  const targetPayload = envelop.payload.target_payload;
  const immediate = envelop.payload.immediate;
  const persisted = envelop.payload.persisted ?? true;

  if (!taskId) {
    envelop.payload = { ok: false, error: "task_id is required" };
    return envelop;
  }

  if (!(taskId in _persistedTasks) && !_tasks.has(taskId)) {
    envelop.payload = { ok: false, error: `task '${taskId}' not found` };
    return envelop;
  }

  const oldConfig = _persistedTasks[taskId] ?? {} as TaskConfig;
  const newConfig: TaskConfig = { ...oldConfig };

  if (interval !== undefined) newConfig.interval = parseInt(interval, 10);
  if (atTime !== undefined) newConfig.at_time = atTime;
  if (targetReceiver !== undefined) newConfig.target_receiver = targetReceiver;
  if (targetPayload !== undefined) {
    newConfig.target_payload = { ...(oldConfig.target_payload ?? {}), ...targetPayload };
  }
  if (immediate !== undefined) newConfig.immediate = immediate;

  // 销毁旧循环
  const state = _tasks.get(taskId);
  if (state) {
    state.stop = true;
    _tasks.delete(taskId);
  }

  if (persisted) {
    _persistedTasks[taskId] = newConfig;
    await savePersistedTasks();
  } else {
    delete _persistedTasks[taskId];
    await savePersistedTasks();
  }

  await startCronLoop(taskId, newConfig, agent);

  const outMode = newConfig.at_time ? "daily" : "interval";
  envelop.payload = {
    ok: true,
    task_id: taskId,
    updated: {
      schedule_mode: outMode,
      interval: newConfig.interval,
      at_time: newConfig.at_time,
      target_receiver: newConfig.target_receiver,
      immediate: newConfig.immediate ?? false,
      persisted,
    },
  };
  return envelop;
}

// ============================================================
// cancel
// ============================================================

async function cancel(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const taskId = envelop.payload.task_id ?? "";

  if (!_tasks.has(taskId)) {
    envelop.payload = { ok: false, error: `task '${taskId}' not found` };
    return envelop;
  }

  const state = _tasks.get(taskId)!;
  state.stop = true;
  _tasks.delete(taskId);

  let persistedRemoved = false;
  if (taskId in _persistedTasks) {
    delete _persistedTasks[taskId];
    await savePersistedTasks();
    persistedRemoved = true;
  }

  envelop.payload = { ok: true, task_id: taskId, persisted_removed: persistedRemoved };
  return envelop;
}

// ============================================================
// list
// ============================================================

async function list(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const tasksInfo: Record<string, any> = {};

  for (const tid of _tasks.keys()) {
    const config = _persistedTasks[tid] ?? {} as TaskConfig;
    const targetPayload = config.target_payload ?? {};

    const payloadPreview: Record<string, any> = {};
    if (targetPayload.session_id) payloadPreview.session_id = targetPayload.session_id;
    if (targetPayload.content) {
      let content = targetPayload.content;
      if (content.length > 100) content = content.slice(0, 100) + "...";
      payloadPreview.content = content;
    }
    if (targetPayload.action) payloadPreview.action = targetPayload.action;

    const atTimeVal = config.at_time;
    const scheduleMode = atTimeVal ? "daily" : "interval";

    tasksInfo[tid] = {
      running: !_tasks.get(tid)?.stop,
      schedule_mode: scheduleMode,
      interval: config.interval,
      at_time: atTimeVal,
      target_receiver: config.target_receiver ?? "?",
      immediate: config.immediate ?? false,
      persisted: tid in _persistedTasks,
      payload: payloadPreview,
      task_id: tid,
    };
  }

  const sortedTasks = Object.fromEntries(
    Object.entries(tasksInfo).sort(([a], [b]) => a.localeCompare(b))
  );
  const total = Object.keys(sortedTasks).length;
  const runningCount = Object.values(sortedTasks).filter((t: any) => t.running).length;

  envelop.payload = {
    ok: true,
    data: {
      tasks: sortedTasks,
      total,
      running: runningCount,
      stopped: total - runningCount,
    },
  };
  return envelop;
}

// ============================================================
// help
// ============================================================

export function help() {
  return {
    route: "os/_cron",
    description: "定时任务插件 v2.2 — 系统级定时调度",
    actions: {
      schedule: "创建定时任务",
      update: "更新已有任务（即时生效）",
      cancel: "取消并删除任务",
      list: "列出所有任务状态",
      restore: "手动恢复持久化任务",
    },
  };
}