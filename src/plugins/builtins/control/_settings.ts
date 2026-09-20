/**
 * builtins/control/_settings — 控制面板 API
 *
 * 读取/修改配置、应用管理、日志
 *
 * 与 Python 版 plugins/builtins/control/_settings.py 对应。
 */

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Envelop } from "../../../core/Envelop.js";
import type { Agent } from "../../../core/Agent.js";
import { LLM } from "../../../runtime/llm.js";

// ============================================================
// yaml 加载（Bun 原生支持 import yaml）
// ============================================================

let _yaml: any = null;

async function getYaml(): Promise<any> {
  if (_yaml) return _yaml;
  // Bun 支持直接 import 第三方包
  _yaml = await import("yaml");
  return _yaml;
}

// ============================================================
// 配置读写
// ============================================================

const CONFIG_PATH = "aicp.yaml";

async function loadConfig(): Promise<any> {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const yaml = await getYaml();
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const cfg = yaml.parse(raw);
    return cfg && typeof cfg === "object" ? cfg : {};
  } catch {
    return {};
  }
}

async function saveConfig(config: any): Promise<void> {
  const yaml = await getYaml();
  const raw = yaml.stringify(config, { lineWidth: 0 });
  await writeFile(CONFIG_PATH, raw, "utf-8");
}

function cleanNull(obj: any): any {
  if (obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj)) {
    return obj.filter((v) => v !== null && v !== undefined).map(cleanNull);
  }
  if (typeof obj === "object") {
    const result: any = {};
    for (const [k, v] of Object.entries(obj)) {
      const cleaned = cleanNull(v);
      if (cleaned !== undefined) result[k] = cleaned;
    }
    return result;
  }
  return obj;
}

// ============================================================
// 主入口
// ============================================================

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  let params = envelop.payload?.params ?? {};
  if (Object.keys(params).length === 0) {
    params = { ...envelop.payload };
  }

  const action = envelop.payload?.action ?? "get";

  // ============================================================
  // get：读 aicp.yaml
  // ============================================================
  if (action === "get") {
    const config = await loadConfig();
    envelop.payload = config;
    return envelop;
  }

  // ============================================================
  // set：改 aicp.yaml
  // ============================================================
  if (action === "set") {
    const key = params.key ?? "";
    const value = params.value;

    if (!key) {
      envelop.payload = { error: "key required" };
      return envelop;
    }

    const config = await loadConfig();
    const keys = key.split(".");

    if (key === "models.providers") {
      if (!config.models) config.models = {};
      config.models.providers = value && typeof value === "object" ? value : {};
    } else {
      let target = config;
      if (value === null || value === undefined) {
        for (const k of keys.slice(0, -1)) {
          if (!(k in target)) target[k] = {};
          target = target[k];
        }
        delete target[keys[keys.length - 1]];
      } else {
        for (const k of keys.slice(0, -1)) {
          if (!(k in target)) target[k] = {};
          target = target[k];
        }
        target[keys[keys.length - 1]] = value;
      }
    }

    const cleaned = cleanNull(config);
    if (!cleaned.models) cleaned.models = {};
    if (!cleaned.models.providers) cleaned.models.providers = {};

    await saveConfig(cleaned);

    // 同步到内存
    if (key === "models.providers") {
      if (!agent.config.models) agent.config.models = {};
      agent.config.models.providers = value && typeof value === "object" ? value : {};
    } else {
      let targetMem = agent.config;
      if (value === null || value === undefined) {
        for (const k of keys.slice(0, -1)) {
          if (!(k in targetMem)) targetMem[k] = {};
          targetMem = targetMem[k];
        }
        delete targetMem[keys[keys.length - 1]];
      } else {
        for (const k of keys.slice(0, -1)) {
          if (!(k in targetMem)) targetMem[k] = {};
          targetMem = targetMem[k];
        }
        targetMem[keys[keys.length - 1]] = value;
      }
    }

    // 重建 LLM
    let llmReloaded = false;
    let llmError: string | null = null;
    if (key.startsWith("models")) {
      try {
        const modelsConfig = agent.config.models;
        if (modelsConfig?.providers) {
          const newLlm = new LLM(modelsConfig);
          (agent as any).llm = newLlm;
          llmReloaded = true;
          console.log(`[control] ✅ LLM 已重建（key=${key}）`);
        } else {
          console.log(`[control] config 更新，但无 providers，跳过 LLM 重建`);
        }
      } catch (e: any) {
        llmError = e?.message ?? String(e);
        console.error(`[control] ❌ LLM 重建失败: ${llmError}`);
      }
    }

    envelop.payload = {
      ok: true,
      key,
      llm_reloaded: llmReloaded,
      llm_error: llmError,
    };
    return envelop;
  }

  // ============================================================
  // list / apps：列应用
  // ============================================================
  if (action === "list" || action === "apps") {
    const apps: any[] = [];
    const scanDirs = [
      { path: "src/plugins/builtins", type: "builtin" },
      { path: "src/plugins/applications", type: "user" },
    ];

    for (const { path: scanDir, type } of scanDirs) {
      if (!existsSync(scanDir)) continue;
      let entries;
      try {
        entries = await readdir(scanDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;

        const appDir = join(scanDir, entry.name);
        let tsFiles = 0;
        try {
          const subEntries = await readdir(appDir, { withFileTypes: true });
          tsFiles = subEntries.filter((e) => e.isFile() && e.name.endsWith(".ts")).length;
        } catch {
          // ignore
        }

        apps.push({
          id: entry.name,
          name: entry.name,
          type,
          auto_start: false,
          ts_files: tsFiles,
          html_files: 0,
          deletable: type !== "builtin",
        });
      }
    }

    envelop.payload = { apps };
    return envelop;
  }

  // ============================================================
  // uninstall：卸载应用
  // ============================================================
  if (action === "uninstall") {
  const appId = params.app_id ?? "";
  if (!appId) {
    envelop.payload = { error: "app_id required" };
    return envelop;
  }
  if (["studio", "mk", "control", "system", "os"].includes(appId)) {
    envelop.payload = { error: "Cannot uninstall system app" };
    return envelop;
  }

  const { rm } = await import("node:fs/promises");

  // ★ 三个都删
  await rm(`src/plugins/applications/${appId}`, { recursive: true, force: true });
  await rm(`src/plugins/www/${appId}.ts`, { force: true });
  await rm(`www/${appId}`, { recursive: true, force: true });

  envelop.payload = { ok: true, app_id: appId };
  return envelop;
}

  // ============================================================
  // logs：读日志
  // ============================================================
  if (action === "logs") {
    const logPath = "data/logs/gateway.log";
    const linesCount = params.lines ?? 100;

    if (!existsSync(logPath)) {
      envelop.payload = { lines: ["日志文件不存在"], total: 0 };
      return envelop;
    }

    try {
      const raw = await readFile(logPath, "utf-8");
      const allLines = raw.split("\n").filter(Boolean);
      const recent = allLines.slice(-linesCount);
      envelop.payload = {
        lines: recent,
        total: allLines.length,
      };
    } catch (e: any) {
      envelop.payload = { lines: [`读取日志失败: ${e?.message ?? e}`], total: 0 };
    }
    return envelop;
  }

  // ============================================================
  // restart：委托 os/restart
  // ============================================================
  if (action === "restart") {
    try {
      const result = await agent.system.call(new Envelop({
        sender: "builtins/control/_settings",
        receiver: "os/restart",
        payload: { action: "restart" },
      }));
      envelop.payload = result?.payload ?? { ok: true, message: "Restarting..." };
    } catch (e: any) {
      envelop.payload = { error: `Restart failed: ${e?.message ?? e}` };
    }
    return envelop;
  }

  envelop.payload = { error: `Unknown action: ${action}` };
  return envelop;
}

// ============================================================
// help
// ============================================================

export function help() {
  return {
    route: "builtins/control/_settings",
    description: "控制面板 API — 读取/修改配置、应用管理、日志",
    input: {
      action: "get | set | list | apps | uninstall | logs | restart",
      key: "配置 key（set 时）",
      value: "配置 value（set 时）",
      app_id: "应用 ID（uninstall 时）",
      lines: "日志行数（logs 时）",
    },
    output: {
      ok: "是否成功",
      data: "结果数据",
    },
  };
}