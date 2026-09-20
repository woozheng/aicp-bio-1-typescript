/**
 * os/restart — 系统重启
 *
 * 与 Python 版 plugins/builtins/os/restart.py 对应。
 */

import { Envelop } from "../../core/Envelop.js";
import type { Agent } from "../../core/Agent.js";

function detectManaged(): string {
  if (process.env.INVOCATION_ID || process.env.JOURNAL_STREAM) return "systemd";
  if (process.env.SUPERVISOR_ENABLED || process.env.SUPERVISOR_PROCESS_NAME) return "supervisor";
  if (process.env.PM2_HOME) return "pm2";
  if (process.env.AICP_RESTART_CMD) return "custom_env";
  return "";
}

function detectDocker(): boolean {
  try {
    const { existsSync } = require("node:fs");
    return existsSync("/.dockerenv");
  } catch {
    return false;
  }
}

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const action = envelop.payload?.action ?? "restart";

  if (action !== "restart") {
    envelop.payload = { error: `Unknown action: ${action}` };
    return envelop;
  }

  agent.log?.info?.(`[restart] 收到重启请求，3秒后重启...`);

  envelop.payload = { ok: true, message: "系统将在3秒后重启" };

  setTimeout(async () => {
    try {
      agent.log?.info?.("[restart] 正在重启...");

      const managed = detectManaged();
      const isDocker = detectDocker();

      if (managed || isDocker) {
        agent.log?.info?.(`[restart] 托管方式: ${managed || "docker"}，退出进程`);
        process.exit(0);
        return;
      }

      // 未托管：spawn 新进程 + 退出
      const argv = process.argv;
      // argv = [bun.exe, src/main.ts]
      const spawnCmd = [argv[0], "run", ...argv.slice(1)];
      agent.log?.info?.(`[restart] spawn: ${spawnCmd.join(" ")}`);

      // ★ 先关闭旧进程的 server，释放端口
      try {
        await agent.system.call(new Envelop({
          sender: "os/restart",
          receiver: "os/_gateway",
          payload: { action: "STOP" },
        }));
        await agent.system.call(new Envelop({
          sender: "os/restart",
          receiver: "os/_websocket",
          payload: { action: "STOP" },
        }));
        await agent.system.call(new Envelop({
          sender: "os/restart",
          receiver: "os/_file_receiver",
          payload: { action: "STOP" },
        }));
        agent.log?.info?.("[restart] 旧 server 已关闭，等待端口释放...");
      } catch (e: any) {
        agent.log?.warn?.(`[restart] 关闭旧 server 失败: ${e?.message ?? e}`);
      }

      // ★ 等 1 秒，让端口完全释放
      await new Promise((r) => setTimeout(r, 1000));

            try {
        if (process.platform === "win32") {
          // Windows：用 start 命令启动独立进程
          Bun.spawn(["cmd", "/c", "start", "", ...spawnCmd], {
            cwd: process.cwd(),
            stdout: "ignore",
            stderr: "ignore",
            stdin: "ignore",
            env: process.env,
          });
        } else {
          // Unix：detached spawn
          Bun.spawn(spawnCmd, {
            cwd: process.cwd(),
            stdout: "ignore",
            stderr: "ignore",
            stdin: "ignore",
            env: process.env,
            detached: true,
          });
        }
        // 等 500ms 确保子进程启动
        await new Promise((r) => setTimeout(r, 500));
      } catch (e: any) {
        agent.log?.error?.(`[restart] spawn 失败: ${e?.message ?? e}`);
        process.exit(1);
        return;
      }

      process.exit(0);
    } catch (e: any) {
      agent.log?.error?.(`[restart] 重启异常: ${e?.message ?? e}`);
      process.exit(1);
    }
  }, 3000);

  return envelop;
}

export function help() {
  return {
    route: "os/restart",
    description: "系统重启 — 跨平台通用版",
    actions: {
      restart: "重启系统（3秒后）",
    },
  };
}