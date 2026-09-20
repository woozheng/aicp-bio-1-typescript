/**
 * remove_tool — 删除已有应用
 *
 * 统一 action 模式：action: "remove"（默认）
 *
 * 输入：target（项目名 / 插件名 / 路径）
 *
 * 删除：
 *   src/plugins/applications/{name}/          整个目录
 *   src/plugins/www/{name}.ts                 前端插件
 *   www/{name}/                               前端 HTML
 *   data/www/{name}/                          前端数据（如果有）
 *
 * 不删 data/{name}/（用户数据）
 */

import { rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Envelop } from "../../../core/Envelop.js";
import { plugins } from "../../../core/plugins.js";
import type { Agent } from "../../../core/Agent.js";

// ============================================================
// 常量
// ============================================================

const PROJECTS_DIR = "src/plugins/applications";
const WWW_PLUGINS_DIR = "src/plugins/www";
const WWW_HTML_DIR = "www";
const DATA_WWW_DIR = "data/www";

// ============================================================
// 项目名解析
// ============================================================

async function getProjectList(agent: Agent): Promise<string[]> {
  try {
    const result = await agent.system.call(
      new Envelop({
        sender: "builtins/tools/remove_tool",
        receiver: "builtins/agents/cogitor",
        payload: { action: "get_map" },
      })
    );
    if (result?.payload?.ok) {
      const grouped = result.payload.data?.grouped ?? {};
      const list: string[] = [];
      // 只从 applications 分类取项目名
      const apps = grouped.applications?.projects ?? {};
      for (const name of Object.keys(apps)) {
        if (!list.includes(name)) list.push(name);
      }
      return list;
    }
    return [];
  } catch {
    return [];
  }
}

async function findProject(agent: Agent, target: string): Promise<string | null> {
  if (!target) return null;

  // 1. 完整路径 applications/xxx/xxx_api → 提取项目名
  if (target.includes("applications/")) {
    const after = target.split("applications/").pop() ?? "";
    const candidate = after.split("/")[0]?.trim();
    if (candidate && existsSync(join(PROJECTS_DIR, candidate))) {
      return candidate;
    }
  }

  // 2. 直接检查文件系统
  if (existsSync(join(PROJECTS_DIR, target))) {
    return target;
  }

  // 去掉 _api / .ts / .py 后缀再检查
  const cleanTarget = target
    .replace(/_api$/, "")
    .replace(/\.ts$/, "")
    .replace(/\.py$/, "");
  if (cleanTarget && cleanTarget !== target) {
    if (existsSync(join(PROJECTS_DIR, cleanTarget))) {
      return cleanTarget;
    }
  }

  // 3. 从 cogitor 拿项目列表
  let projects = await getProjectList(agent);
  if (projects.length === 0) {
    // 兜底：直接扫目录
    try {
      const entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
      projects = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      projects = [];
    }
  }

  if (projects.includes(target)) return target;

  const targetLower = target.toLowerCase();
  for (const p of projects) {
    if (p.toLowerCase() === targetLower) return p;
  }

  for (const p of projects) {
    if (p.includes(target) || target.includes(p)) return p;
  }

  if (cleanTarget && cleanTarget !== target) {
    for (const p of projects) {
      if (p.includes(cleanTarget) || cleanTarget.includes(p)) return p;
    }
  }

  return null;
}

// ============================================================
// 主入口
// ============================================================

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const action = envelop.payload?.action ?? "remove";

  let params = envelop.payload?.params ?? {};
  if (Object.keys(params).length === 0) {
    params = { ...envelop.payload };
  }

  if (action !== "remove") {
    envelop.payload = { ok: false, error: `未知 action: ${action}` };
    return envelop;
  }

  const target = params.target ?? params.name ?? "";
  if (!target) {
    envelop.payload = { ok: false, error: "缺少 target 参数" };
    return envelop;
  }

  // 安全检查：禁止路径穿越
  if (target.includes("..")) {
    envelop.payload = { ok: false, error: "target 含非法字符" };
    return envelop;
  }

  let projectName: string | null;
  try {
    projectName = await findProject(agent, target);
  } catch (e: any) {
    envelop.payload = { ok: false, error: `解析项目名失败: ${e?.message ?? e}` };
    return envelop;
  }

  if (!projectName) {
    envelop.payload = { ok: false, error: `未找到项目: ${target}` };
    return envelop;
  }

  // 安全检查：项目名不能含路径分隔符
  if (projectName.includes("/") || projectName.includes("\\")) {
    envelop.payload = { ok: false, error: "项目名含非法字符" };
    return envelop;
  }

  // 收集要删的路径
  const candidates = [
    join(PROJECTS_DIR, projectName),                // 后端目录
    join(WWW_PLUGINS_DIR, `${projectName}.ts`),     // 前端插件
    join(WWW_HTML_DIR, projectName),                // 前端 HTML
    join(DATA_WWW_DIR, projectName),                // 前端数据（如果有）
  ];

  const existing = candidates.filter((p) => existsSync(p));

  if (existing.length === 0) {
    envelop.payload = {
      ok: false,
      error: `项目 ${projectName} 不存在`,
    };
    return envelop;
  }

  // 删除
  const deleted: string[] = [];
  const errors: string[] = [];

  for (const path of existing) {
    try {
      await rm(path, { recursive: true, force: true });
      deleted.push(path);
    } catch (e: any) {
      errors.push(`${path}: ${e?.message ?? String(e)}`);
    }
  }

  // 等 watcher 卸载
  await new Promise((r) => setTimeout(r, 3000));

  // 验证：相关 receiver 是否已从 plugins Map 移除
  const stillLoaded = Array.from(plugins.keys()).filter(
    (k) =>
      k.startsWith(`applications/${projectName}/`) ||
      k === `www/${projectName}`
  );
  const unloaded = stillLoaded.length === 0;

  // 返回
  if (errors.length > 0) {
    envelop.payload = {
      ok: false,
      error: `部分删除失败: ${errors.join("; ")}`,
      data: {
        project_name: projectName,
        removed: deleted,
        errors,
        unloaded,
      },
    };
    return envelop;
  }

  envelop.payload = {
    ok: true,
    data: {
      project_name: projectName,
      removed: deleted,
      unloaded,
    },
    message: unloaded
      ? `🗑️ 已删除项目 \`${projectName}\`\n共删除 ${deleted.length} 个文件/目录`
      : `⚠️ 文件已删除，但插件未卸载：${projectName}（可能需要重启）`,
  };
  return envelop;
}

// ============================================================
// help
// ============================================================

export function help() {
  return {
    route: "builtins/tools/remove_tool",
    description: "删除整个项目（包括前后端）",
    input: {
      action: "remove（默认）",
      target: "项目名、插件名、或路径",
    },
    output: {
      ok: "是否成功",
      data: {
        project_name: "解析出的项目名",
        removed: "删除的文件/目录列表",
        unloaded: "插件是否已卸载",
      },
      message: "结果消息",
    },
  };
}