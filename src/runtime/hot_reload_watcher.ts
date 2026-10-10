/**
 * Hot Reload Watcher — 自动检测插件变化并重载
 */

import { readdir, stat, readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { plugins } from "../core/plugins.js";
import { Envelop } from "../core/Envelop.js";
import type { SystemServer } from "./system.js";

interface WatcherOptions {
  pluginsDir?: string;
  interval?: number;
  system: SystemServer;
}

const _mtimeCache: Map<string, number> = new Map();
const _hashCache: Map<string, string> = new Map();

// ★ 记录已经警告过的路由，避免重复刷屏
const _warnedNoExecute: Set<string> = new Set();

// ★ 失败重试计数（避免语法错误时每 2 秒刷屏）
const _retryCount: Map<string, number> = new Map();
const MAX_RETRY = 5;

let _system: SystemServer | null = null;
let _pluginsDir = "src/plugins";
let _interval = 2000;

// ============================================================
// 启动
// ============================================================

export function startHotReloadWatcher(options: WatcherOptions): void {
  _system = options.system;
  _pluginsDir = options.pluginsDir ?? "src/plugins";
  _interval = (options.interval ?? 2) * 1000;

  initCaches().then(() => {
    console.log(`[HotReload] Watcher started (interval=${_interval}ms, watching ${_pluginsDir}/)`);
    setInterval(tick, _interval);
  });
}

async function initCaches(): Promise<void> {
  const files = await scanAll();
  for (const [filePath, mtime] of files) {
    _mtimeCache.set(filePath, mtime);
    const hash = await calcHash(filePath);
    _hashCache.set(filePath, hash);
  }
}

// ============================================================
// 扫描循环
// ============================================================

async function tick(): Promise<void> {
  try {
    const currentFiles = await scanAll();
    const currentPaths = new Set(currentFiles.keys());

    for (const [filePath, mtime] of currentFiles) {
      const cachedMtime = _mtimeCache.get(filePath);

      if (cachedMtime === undefined) {
        await handleNew(filePath, mtime);
      } else if (mtime > cachedMtime) {
        await handleModified(filePath, mtime);
      }
    }

    for (const filePath of _mtimeCache.keys()) {
      if (!currentPaths.has(filePath)) {
        await handleRemoved(filePath);
      }
    }
  } catch (e) {
    console.error("[HotReload] Watcher error:", e);
  }
}

// ============================================================
// 新增
// ============================================================

async function handleNew(filePath: string, mtime: number): Promise<void> {
  await sleep(500);

  try {
    const s = await stat(filePath);
    if (s.mtimeMs !== mtime) return;
    if (s.size === 0) return;              // ★ 空文件跳过，等下次 tick
  } catch {
    return;
  }

  const route = calcRoute(filePath);
  const hash = await calcHash(filePath);
  const ok = await loadPlugin(filePath, route, false);

  if (ok) {
    _mtimeCache.set(filePath, mtime);
    _hashCache.set(filePath, hash);
    _retryCount.delete(filePath);
    await deleteContractFile(filePath);
    console.log(`[HotReload] New plugin: ${route}`);
    await notifyRegistry(route);
  } else {
    // ★ 失败不缓存 mtime/hash，下个 tick 自动重试（loadPlugin 每次用新 URL）
    const n = (_retryCount.get(filePath) ?? 0) + 1;
    _retryCount.set(filePath, n);
    if (n >= MAX_RETRY) {
      _mtimeCache.set(filePath, mtime);
      _hashCache.set(filePath, hash);
      _retryCount.delete(filePath);
      console.warn(`[HotReload] Give up after ${n} retries: ${route}`);
    } else {
      console.warn(`[HotReload] Retry ${n}/${MAX_RETRY}: ${route}`);
    }
  }
}

// ============================================================
// 修改
// ============================================================

async function handleModified(filePath: string, mtime: number): Promise<void> {
  await sleep(500);

  try {
    const s = await stat(filePath);
    if (s.mtimeMs !== mtime) return;
  } catch {
    return;
  }

  const hash = await calcHash(filePath);
  const cachedHash = _hashCache.get(filePath);
  if (hash === cachedHash) {
    _mtimeCache.set(filePath, mtime);
    return;
  }

  const route = calcRoute(filePath);
  const ok = await loadPlugin(filePath, route, true);

  if (ok) {
    _mtimeCache.set(filePath, mtime);
    _hashCache.set(filePath, hash);
    _retryCount.delete(filePath);
    await deleteContractFile(filePath);
    console.log(`[HotReload] Reloaded: ${route}`);
    await notifyRegistry(route);
  } else {
    // ★ 失败不更新 mtime/hash，下个 tick 重试
    const n = (_retryCount.get(filePath) ?? 0) + 1;
    _retryCount.set(filePath, n);
    if (n >= MAX_RETRY) {
      _mtimeCache.set(filePath, mtime);
      _hashCache.set(filePath, hash);
      _retryCount.delete(filePath);
      console.warn(`[HotReload] Give up after ${n} retries: ${route}`);
    } else {
      console.warn(`[HotReload] ${route} not loaded (retry ${n}/${MAX_RETRY})`);
    }
  }
}

// ============================================================
// 删除
// ============================================================

async function handleRemoved(filePath: string): Promise<void> {
  const route = calcRoute(filePath);
  _mtimeCache.delete(filePath);
  _hashCache.delete(filePath);
  _retryCount.delete(filePath);          // ★ 清理重试计数
  _warnedNoExecute.delete(route);        // ★ 清理警告记录

  if (plugins.has(route)) {
    plugins.delete(route);
    console.log(`[HotReload] Removed: ${route}`);
    await notifyRegistry(route);
  }
  await deleteContractFile(filePath);
}

// ============================================================
// 扫描
// ============================================================

async function scanAll(): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  await walk(_pluginsDir, result);
  return result;
}

/**
 * ★ 判断是否是可加载的插件文件
 */
function isPluginFile(name: string): boolean {
  if (!name.endsWith(".ts") && !name.endsWith(".js")) return false;
  if (name.endsWith(".d.ts")) return false;
  if (name.includes(".test.")) return false;
  if (name.includes(".spec.")) return false;
  if (name.endsWith(".contract.json")) return false;
  return true;
}

async function walk(dir: string, result: Map<string, number>): Promise<void> {
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
    } else if (isPluginFile(entry.name)) {
      try {
        const s = await stat(fullPath);
        result.set(fullPath, s.mtimeMs);
      } catch {}
    }
  }
}

function calcRoute(filePath: string): string {
  const rel = relative(_pluginsDir, filePath);
  return rel.replace(/\.(ts|js)$/, "").replace(/\\/g, "/");
}

// ============================================================
// Hash
// ============================================================

async function calcHash(filePath: string): Promise<string> {
  try {
    const content = await readFile(filePath);
    return createHash("md5").update(content).digest("hex");
  } catch {
    return "";
  }
}

// ============================================================
// 加载
// ============================================================

async function loadPlugin(
  filePath: string,
  route: string,
  force: boolean = false
): Promise<boolean> {
  try {
    let absPath = join(process.cwd(), filePath);
    // ★ Windows 盘符统一大写，避免 e:/E: 两种 URL
    if (/^[a-z]:/.test(absPath)) {
      absPath = absPath[0].toUpperCase() + absPath.slice(1);
    }
    // ★ 时间戳 + 随机数，URL 绝对唯一，绕开所有缓存
    const url = pathToFileURL(absPath).href + `?t=${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const module = await import(url);

    if (typeof module.execute !== "function") {
      if (!_warnedNoExecute.has(route)) {
        _warnedNoExecute.add(route);
        console.log(`[HotReload] Skip (no execute): ${route}`);
      }
      return false;
    }

    _warnedNoExecute.delete(route);
    plugins.set(route, module.execute);
    return true;
  } catch (e: any) {
    console.warn(`[HotReload] Failed to load ${route}: ${e.message}`);
    return false;
  }
}

// ============================================================
// 通知 registry
// ============================================================

async function notifyRegistry(route: string): Promise<void> {
  if (!_system) return;

  try {
    await _system.call(new Envelop({
      sender: "runtime/hot_reload_watcher",
      receiver: "os/_registry",
      payload: { action: "reload", route },
    }));
  } catch (e: any) {
    console.error(`[HotReload] Failed to notify registry for ${route}:`, e.message);
  }
}

// ============================================================
// 工具
// ============================================================

async function deleteContractFile(filePath: string): Promise<void> {
  const contractPath = filePath.replace(/\.(ts|js)$/, ".contract.json");
  if (existsSync(contractPath)) {
    try {
      await unlink(contractPath);
      console.log(`[HotReload] Deleted contract: ${contractPath}`);
    } catch (e: any) {
      console.warn(`[HotReload] Failed to delete contract ${contractPath}: ${e?.message ?? e}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
