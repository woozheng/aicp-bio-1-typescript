/**
 * os/_registry — 插件注册中心
 *
 * 职责（修正版）：
 * - 扫描 src/plugins/（发现文件）
 * - 查询接口（list / get / stats）
 * - 更新元数据（被 hot_reload_watcher 通知时）
 *
 * ★ 不再“重新加载”模块。
 *   加载由 hot_reload_watcher 统一负责。
 *   _registry 只“扫描 + 记录 + 查询”。
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { plugins } from "../../core/plugins.js";
import { Envelop } from "../../core/Envelop.js";
import type { Agent } from "../../core/Agent.js";

// ============================================================
// 常量
// ============================================================

const PLUGINS_ROOT = "src/plugins";
const CACHE_FILE = "data/registry_cache.json";

// ============================================================
// 元数据模型
// ============================================================

interface PluginMeta {
  name: string;
  file_path: string;
  file_hash: string;
  is_loaded: boolean;
  load_error: string | null;
  last_loaded: string | null;
}

const _meta: Map<string, PluginMeta> = new Map();
let _cacheDirty = false;

// ============================================================
// 主入口
// ============================================================

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const action = envelop.payload.action ?? "list";

  // 首次调用时加载缓存
  if (_meta.size === 0 && existsSync(CACHE_FILE)) {
    await loadCache();
  }

  // 同步 is_loaded 状态（和 plugins 字典对齐）
  syncLoadedState();

  if (action === "list") return await handleList(envelop);
  if (action === "get") return await handleGet(envelop);
  if (action === "stats") return await handleStats(envelop);
  if (action === "sync") return await handleSync(envelop, agent);
  if (action === "reload") return await handleReload(envelop, agent);
  if (action === "unload") return await handleUnload(envelop, agent);
  if (action === "refresh") return await handleRefresh(envelop, agent);

  envelop.payload = { ok: false, error: `Unknown action: ${action}` };
  return envelop;
}

// ============================================================
// 状态同步
// ============================================================

/**
 * 同步 is_loaded 状态：plugins 里有但 _meta 说没加载的，修正
 */
function syncLoadedState(): void {
  for (const name of plugins.keys()) {
    const meta = _meta.get(name);
    if (meta && !meta.is_loaded) {
      meta.is_loaded = true;
      meta.last_loaded = new Date().toISOString();
      _cacheDirty = true;
    }
  }
}

// ============================================================
// 扫描
// ============================================================

async function scanPlugins(): Promise<number> {
  const files = await findPluginFiles();
  let discovered = 0;

  for (const [name, filePath] of files) {
    if (!_meta.has(name)) {
      _meta.set(name, {
        name,
        file_path: filePath,
        file_hash: "",
        is_loaded: plugins.has(name),
        load_error: null,
        last_loaded: null,
      });
      discovered++;
      _cacheDirty = true;
    } else {
      // 更新 file_path（可能变了）
      const meta = _meta.get(name)!;
      if (meta.file_path !== filePath) {
        meta.file_path = filePath;
        _cacheDirty = true;
      }
      // 更新 is_loaded
      if (plugins.has(name) && !meta.is_loaded) {
        meta.is_loaded = true;
        meta.last_loaded = new Date().toISOString();
        _cacheDirty = true;
      }
    }
  }

  // 检查已删除的插件
  for (const name of Array.from(_meta.keys())) {
    const meta = _meta.get(name)!;
    if (!existsSync(meta.file_path)) {
      _meta.delete(name);
      // 注意：不删除 plugins 字典里的，由 watcher 处理
      _cacheDirty = true;
    }
  }

  return discovered;
}

async function findPluginFiles(): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  await walk(PLUGINS_ROOT, result);
  return result;
}

async function walk(dir: string, result: Map<string, string>): Promise<void> {
  if (!existsSync(dir)) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("hotreload_")) continue;
    if (entry.name === "node_modules") continue;
    if (entry.name === "__pycache__") continue;

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      await walk(fullPath, result);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) {
      const rel = relative(PLUGINS_ROOT, fullPath);
      const receiver = rel.replace(/\.(ts|js)$/, "").replace(/\\/g, "/");
      result.set(receiver, fullPath);
    }
  }
}

// ============================================================
// 缓存
// ============================================================

async function loadCache(): Promise<void> {
  if (!existsSync(CACHE_FILE)) return;
  try {
    const raw = await readFile(CACHE_FILE, "utf-8");
    const data = JSON.parse(raw);
    for (const [name, meta] of Object.entries(data.plugins ?? {})) {
      _meta.set(name, meta as PluginMeta);
    }
  } catch {
    // ignore
  }
}

async function saveCache(): Promise<void> {
  if (!_cacheDirty) return;
  try {
    await mkdir("data", { recursive: true });
    const data = {
      version: "1.0",
      updated: new Date().toISOString(),
      total: _meta.size,
      plugins: Object.fromEntries(_meta),
    };
    await writeFile(CACHE_FILE, JSON.stringify(data, null, 2), "utf-8");
    _cacheDirty = false;
  } catch {
    // ignore
  }
}

// ============================================================
// 处理器
// ============================================================

async function handleList(envelop: Envelop): Promise<Envelop> {
  await scanPlugins();
  await saveCache();

  const list = Array.from(plugins.keys()).sort();
  envelop.payload = {
    ok: true,
    count: list.length,
    plugins: list,
    stats: {
      total: _meta.size,
      loaded: list.length,
    },
  };
  return envelop;
}

async function handleGet(envelop: Envelop): Promise<Envelop> {
  const name = envelop.payload.name ?? "";
  if (!name) {
    envelop.payload = { ok: false, error: "name required" };
    return envelop;
  }

  const meta = _meta.get(name);
  if (!meta) {
    envelop.payload = { ok: false, error: `Plugin not found: ${name}` };
    return envelop;
  }

  // 用 plugins 字典的真实状态
  meta.is_loaded = plugins.has(name);

  envelop.payload = { ok: true, plugin: meta };
  return envelop;
}

async function handleStats(envelop: Envelop): Promise<Envelop> {
  const loaded = Array.from(plugins.keys()).length;
  envelop.payload = {
    ok: true,
    stats: {
      total: _meta.size,
      loaded,
      cache_file: CACHE_FILE,
    },
  };
  return envelop;
}

/**
 * ★ sync 只扫描 + 更新元数据，不加载
 */
async function handleSync(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const discovered = await scanPlugins();
  syncLoadedState();
  await saveCache();

  envelop.payload = {
    ok: true,
    discovered,
    stats: {
      total: _meta.size,
      loaded: Array.from(plugins.keys()).length,
    },
  };
  return envelop;
}

/**
 * ★ reload 只更新元数据，不加载
 *   加载由 hot_reload_watcher 负责
 */
async function handleReload(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const name = envelop.payload.route ?? envelop.payload.name ?? "";
  if (!name) {
    envelop.payload = { ok: false, error: "route required" };
    return envelop;
  }

  await scanPlugins();
  const meta = _meta.get(name);

  if (!meta) {
    // 文件不存在，_meta 里删掉（不删 plugins，由 watcher 处理）
    envelop.payload = { ok: true, route: name, removed: true };
    return envelop;
  }

  // 只更新元数据
  meta.is_loaded = plugins.has(name);
  meta.load_error = null;
  meta.last_loaded = new Date().toISOString();
  _cacheDirty = true;
  await saveCache();

  envelop.payload = {
    ok: true,
    route: name,
    info: meta,
    message: `Registry updated for ${name}`,
  };
  return envelop;
}

async function handleUnload(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const name = envelop.payload.name ?? "";
  if (!name) {
    envelop.payload = { ok: false, error: "name required" };
    return envelop;
  }

  plugins.delete(name);
  const meta = _meta.get(name);
  if (meta) {
    meta.is_loaded = false;
    meta.last_loaded = null;
  }
  _cacheDirty = true;
  await saveCache();

  envelop.payload = { ok: true, name };
  return envelop;
}

/**
 * refresh — 清空缓存 + 重新扫描（不重新加载）
 */
async function handleRefresh(envelop: Envelop, agent: Agent): Promise<Envelop> {
  if (existsSync(CACHE_FILE)) {
    try {
      await writeFile(CACHE_FILE, "{}", "utf-8");
    } catch {
      // ignore
    }
  }

  _meta.clear();
  _cacheDirty = true;

  await scanPlugins();
  syncLoadedState();
  await saveCache();

  envelop.payload = {
    ok: true,
    stats: {
      total: _meta.size,
      loaded: Array.from(plugins.keys()).length,
    },
    message: "Registry refreshed (metadata only)",
  };
  return envelop;
}

// ============================================================
// help
// ============================================================

export function help() {
  return {
    route: "os/_registry",
    description: "插件注册中心 — 查询 + 元数据管理（加载由 watcher 负责）",
    actions: {
      list: "列出所有已加载插件",
      get: "查询单个插件信息",
      stats: "统计信息",
      sync: "同步元数据（扫描 + 更新状态）",
      reload: "更新元数据（不重新加载）",
      unload: "卸载指定插件（从 plugins 字典移除）",
      refresh: "清空缓存 + 重新扫描（不重新加载）",
    },
    input: {
      action: "required - list|get|stats|sync|reload|unload|refresh",
      name: "optional - 插件名（get/unload 时）",
      route: "optional - 插件路由（reload 时）",
    },
  };
}