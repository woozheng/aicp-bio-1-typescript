/**
 * Plugin Loader — 扫描并加载插件（含依赖自动安装）
 *
 * 职责：
 * 1. 扫描 plugins/ 目录
 * 2. 解析 @DEPS 声明，缺失的自动 npm install
 * 3. 动态 import 每个插件
 * 4. 检查 module.execute
 * 5. 注册到 core.plugins
 *
 * ★ 设计说明：
 * - 不"提前判断是不是插件"（那会引入 stripStringLiterals 的 bug）
 * - 先 parseDeps（只扫前 30 行注释行，prompt 不会被误读）
 * - 再 import（prompt 是合法 TS，import 不报错）
 * - 再检查 module.execute（不是函数就跳过）
 * - prompt 文件 import 后 module.execute 是 undefined，被自然跳过
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { SystemServer } from "./system.js";
import { parseDeps, ensureDeps } from "./dep_utils.js";

// ============================================================
// PluginLoader
// ============================================================

export class PluginLoader {
  system: SystemServer;
  pluginsDir: string;

  constructor(system: SystemServer, pluginsDir: string = "src/plugins") {
    this.system = system;
    this.pluginsDir = pluginsDir;
  }

  // ============================================================
  // 加载全部
  // ============================================================

  async loadAll(): Promise<number> {
    const files = await this._scan(this.pluginsDir);
    let loaded = 0;

    for (const file of files) {
      try {
        const ok = await this.loadOne(file);
        if (ok) loaded++;
      } catch (e) {
        console.error(`[PluginLoader] Failed to load ${file}:`, e);
      }
    }

    return loaded;
  }

  // ============================================================
  // 加载单个
  // ============================================================

  async loadOne(filePath: string): Promise<boolean> {
    // 计算 receiver：相对 plugins/ 的路径，去掉扩展名
    const rel = relative(this.pluginsDir, filePath);
    const receiver = rel.replace(/\.(ts|js)$/, "").replace(/\\/g, "/");

    // ★ 1. 读源码（用于解析 @DEPS）
    let source = "";
    try {
      source = await readFile(filePath, "utf-8");
    } catch (e: any) {
      console.warn(`[PluginLoader] Cannot read ${filePath}: ${e.message}`);
      return false;
    }

    // ★ 2. 解析 @DEPS（只扫前 30 行注释行，prompt 不会被误读）
    const deps = parseDeps(source);
    if (deps.length > 0) {
      console.log(
        `[PluginLoader] ${receiver} 声明了 ${deps.length} 个依赖: ${deps.join(", ")}`
      );
      await ensureDeps(deps);
    }

    // ★ 3. 动态 import
    const absPath = join(process.cwd(), filePath);
    let module: any;
    try {
      module = await import(`file://${absPath}`);
    } catch (e: any) {
      console.warn(`[PluginLoader] Cannot import ${receiver}: ${e.message}`);
      return false;
    }

    // ★ 4. 检查 execute
    //     prompt 文件（fix_backend.ts 等）import 后 module.execute 是 undefined
    //     会被这里自然跳过
    if (typeof module.execute !== "function") {
      console.log(`[PluginLoader] Skip (no execute): ${receiver}`);
      return false;
    }

    // ★ 5. 注册
    this.system.register(receiver, module.execute);
    console.log(`[PluginLoader] Loaded: ${receiver}`);
    return true;
  }

  // ============================================================
  // 扫描
  // ============================================================

  private async _scan(dir: string): Promise<string[]> {
    const result: string[] = [];

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return result;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;
      if (entry.name === "__pycache__") continue;

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        result.push(...(await this._scan(fullPath)));
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) {
        if (entry.name.endsWith(".d.ts")) continue;
        if (entry.name.includes(".test.")) continue;
        if (entry.name.includes(".spec.")) continue;
        result.push(fullPath);
      }
    }

    return result;
  }
}
