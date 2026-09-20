/**
 * Hot Reload Watcher — 自动检测插件变化并重载
 */

import { readdir, stat, readFile, copyFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, dirname, extname } from "node:path";
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
  } catch {
    return;
  }

  const route = calcRoute(filePath);
  const hash = await calcHash(filePath);
  const ok = await loadPlugin(filePath, route, false);

  // ★ 无论成功失败，都更新 mtime 和 hash（避免反复重试）
  _mtimeCache.set(filePath, mtime);
  _hashCache.set(filePath, hash);

  if (ok) {
    await deleteContractFile(filePath);   //
    console.log(`[HotReload] New plugin: ${route}`);
    await notifyRegistry(route);
  }
  // 失败时不打日志（loadPlugin 内部已处理）
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

  // ★ 无论成功失败，都更新 mtime 和 hash
  _mtimeCache.set(filePath, mtime);
  _hashCache.set(filePath, hash);

  if (ok) {
     await deleteContractFile(filePath);   //
    console.log(`[HotReload] Reloaded: ${route}`);
    await notifyRegistry(route);
  } else {
    console.warn(`[HotReload] ${route} not loaded (keeping old version)`);
  }
}

// ============================================================
// 删除
// ============================================================

async function handleRemoved(filePath: string): Promise<void> {
  const route = calcRoute(filePath);
  _mtimeCache.delete(filePath);
  _hashCache.delete(filePath);
  _warnedNoExecute.delete(route);  // ★ 清理警告记录

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
  // 必须是 .ts 或 .js
  if (!name.endsWith(".ts") && !name.endsWith(".js")) return false;

  // 排除 .d.ts
  if (name.endsWith(".d.ts")) return false;

  // 排除测试文件
  if (name.includes(".test.")) return false;
  if (name.includes(".spec.")) return false;

  // 排除 .contract.json 等（虽然上面已经排除了非 .ts/.js）
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
    // 跳过隐藏文件、临时文件、特殊目录
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
  let tmpPath: string | null = null;

  try {
    const absPath = join(process.cwd(), filePath);
    let importPath = absPath;

    if (force) {
      const dir = dirname(absPath);
      const ext = extname(absPath);
      const tmpName = `hotreload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
      tmpPath = join(dir, tmpName);
      await copyFile(absPath, tmpPath);
      importPath = tmpPath;
    }

    const url = pathToFileURL(importPath).href;
    const module = await import(url);

    if (typeof module.execute !== "function") {
      // ★ 只在第一次警告，避免刷屏
      if (!_warnedNoExecute.has(route)) {
        _warnedNoExecute.add(route);
        console.log(`[HotReload] Skip (no execute): ${route}`);
      }
      return false;
    }

    // ★ 加载成功后，清掉警告记录（下次再没 execute 会重新警告）
    _warnedNoExecute.delete(route);

    plugins.set(route, module.execute);
    return true;
  } catch (e: any) {
    // 加载失败（语法错误等）
    console.warn(`[HotReload] Failed to load ${route}: ${e.message}`);
    return false;
  } finally {
    if (tmpPath) {
      try { await unlink(tmpPath); } catch {}
    }
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
  // filePath 是 .ts 文件路径
  // 契约文件同目录，同前缀，后缀 .contract.json
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