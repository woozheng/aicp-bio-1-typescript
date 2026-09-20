/**
 * logger — 简单日志（劫持 console，写到 data/logs/gateway.log）
 *
 * 在 main.ts 启动时调用 installLogger() 即可。
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const LOG_DIR = "data/logs";
const LOG_FILE = join(LOG_DIR, "gateway.log");

let _logReady = false;
let _logReadyPromise: Promise<void> | null = null;

async function ensureLogDir(): Promise<void> {
  if (_logReady) return;
  if (!_logReadyPromise) {
    _logReadyPromise = mkdir(LOG_DIR, { recursive: true }).then(() => {
      _logReady = true;
    });
  }
  return _logReadyPromise;
}

function fmtArg(a: any): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return `${a.message}\n${a.stack ?? ""}`;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function appendLog(level: string, args: any[]): void {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(fmtArg).join(" ")}\n`;
  ensureLogDir()
    .then(() => appendFile(LOG_FILE, line, "utf-8"))
    .catch(() => {
      // 静默失败，不阻塞主流程
    });
}

let _installed = false;

export function installLogger(): void {
  if (_installed) return;
  _installed = true;

  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  console.log = (...args: any[]) => {
    origLog(...args);
    appendLog("INFO", args);
  };

  console.warn = (...args: any[]) => {
    origWarn(...args);
    appendLog("WARN", args);
  };

  console.error = (...args: any[]) => {
    origError(...args);
    appendLog("ERROR", args);
  };
}