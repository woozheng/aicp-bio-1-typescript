/**
 * cogitor — AICP 系统概览（极简版）
 * ================================
 * 无状态、实时、按需。
 *
 * - get_map：实时扫描 _registry，返回系统概览
 * - list_plugins：列出所有插件名
 *
 * 分类规则：
 *   三级（builtins/agents/cogitor）→ 按 project（parts[1]）分组
 *   两级（os/_gateway, www/demo）→ 直接列
 */

import { Envelop } from "../../../core/Envelop.js";
import type { Agent } from "../../../core/Agent.js";

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
// 主入口
// ============================================================

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const action = envelop.payload?.action ?? "get_map";

  if (action === "get_map") {
    let pluginNames: string[];
    try {
      pluginNames = await fetchPluginNames(agent);
    } catch (e) {
      envelop.payload = { ok: false, error: `${e}` };
      return envelop;
    }

    // 分类
    const grouped: Record<string, { projects: Record<string, string[]>; direct: string[] }> = {};
    for (const name of pluginNames) {
      const parts = name.split("/");
      let category: string;
      let project: string | null;

      if (parts.length >= 3) {
        category = parts[0];
        project = parts[1];
      } else if (parts.length === 2) {
        category = parts[0];
        project = null;
      } else {
        category = "_root";
        project = null;
      }

      if (!grouped[category]) grouped[category] = { projects: {}, direct: [] };
      if (project) {
        if (!grouped[category].projects[project]) grouped[category].projects[project] = [];
        grouped[category].projects[project].push(name);
      } else {
        grouped[category].direct.push(name);
      }
    }

    const totalPlugins = pluginNames.length;

    const summaryLines: string[] = [
      `系统共有 ${totalPlugins} 个插件。`,
      "",
    ];

    for (const category of Object.keys(grouped).sort()) {
      if (category === "_root") continue;
      summaryLines.push(`【${category}】`);

      const { projects, direct } = grouped[category];

      // 有 project 的按 project 分组
      for (const project of Object.keys(projects).sort()) {
        const list = projects[project];
        summaryLines.push(`  • ${project}（${list.length}个插件）`);
        for (const plugin of [...list].sort()) {
          summaryLines.push(`      - ${plugin}`);
        }
      }

      // 没有 project 的直接列
      for (const plugin of [...direct].sort()) {
        summaryLines.push(`  - ${plugin}`);
      }

      summaryLines.push("");
    }

    envelop.payload = {
      ok: true,
      summary: summaryLines.join("\n"),
      data: {
        total_plugins: totalPlugins,
        total_frontend: 0,
        frontend: {},
        grouped,
      },
    };
    return envelop;
  }

  if (action === "list_plugins") {
    try {
      const pluginNames = await fetchPluginNames(agent);
      envelop.payload = {
        ok: true,
        plugins: pluginNames,
        total: pluginNames.length,
      };
      return envelop;
    } catch (e) {
      envelop.payload = { ok: false, error: `${e}` };
      return envelop;
    }
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
    description: "AICP 系统概览 — 实时扫描 _registry，零 token",
    input: {
      action: "get_map | list_plugins",
    },
    output: {
      ok: "是否成功",
      summary: "系统概览文本",
      data: "结构化数据",
    },
  };
}