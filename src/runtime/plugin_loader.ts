/**
 * Plugin Loader — 扫描并加载插件
 *
 * 职责：
 * 1. 扫描 plugins/ 目录
 * 2. 动态 import 每个插件
 * 3. 注册到 core.plugins
 *
 * 这是 Python 版 runtime/_plugin_loader.py 的 TS 对应。
 */

import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { SystemServer } from "./system.js";

export class PluginLoader {
  system: SystemServer;
  pluginsDir: string;

  constructor(system: SystemServer, pluginsDir: string = "src/plugins") {
    this.system = system;
    this.pluginsDir = pluginsDir;
  }

  /**
   * 扫描并加载所有插件
   */
  async loadAll(): Promise<number> {
    const files = await this._scan(this.pluginsDir);
    let loaded = 0;

    for (const file of files) {
      try {
        await this.loadOne(file);
        loaded++;
      } catch (e) {
        console.error(`[PluginLoader] Failed to load ${file}:`, e);
      }
    }

    return loaded;
  }

  /**
   * 加载单个插件
   */
  async loadOne(filePath: string): Promise<void> {
    // 计算 receiver：相对 plugins/ 的路径，去掉扩展名
    // 例如：src/plugins/os/_gateway.ts → os/_gateway
    const rel = relative(this.pluginsDir, filePath);
    const receiver = rel.replace(/\.(ts|js)$/, "").replace(/\\/g, "/");

    // 动态 import（用绝对路径）
    const absPath = join(process.cwd(), filePath);
    const module = await import(`file://${absPath}`);

   if (typeof module.execute !== "function") {
  console.log(`[PluginLoader] Skip (no execute): ${receiver}`);
  return;
}

    this.system.register(receiver, module.execute);
    console.log(`[PluginLoader] Loaded: ${receiver}`);
  }

  /**
   * 扫描目录，返回所有 .ts / .js 文件
   */
  private async _scan(dir: string): Promise<string[]> {
    const result: string[] = [];

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return result;
    }

    for (const entry of entries) {
      // 跳过隐藏文件、node_modules、__pycache__
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;
      if (entry.name === "__pycache__") continue;

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        result.push(...(await this._scan(fullPath)));
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) {
        result.push(fullPath);
      }
    }

    return result;
  }
}