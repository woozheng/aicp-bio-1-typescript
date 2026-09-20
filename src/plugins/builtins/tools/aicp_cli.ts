/**
 * aicp_cli — 本地逃生通道
 *
 * 用 Bun.spawn 调本地 Python CLI（aicp.py --exec）。
 * CLI 是"纯执行器"：接收 task + llm_config，执行，返回 JSON。
 *
 * 统一 action 模式：action: "exec"（默认）
 */

import { Envelop } from "../../../core/Envelop.js";
import type { Agent } from "../../../core/Agent.js";

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  // 统一 action 模式
  const action = envelop.payload?.action ?? "exec";

  // 兼容两种传参：payload.params.xxx 或 payload.xxx
  let params = envelop.payload?.params ?? {};
  if (Object.keys(params).length === 0) {
    params = { ...envelop.payload };
  }

  // action 校验
  if (action !== "exec") {
    envelop.payload = { ok: false, error: `未知 action: ${action}` };
    return envelop;
  }

  const task = params.task ?? "";
  const timeout = params.timeout ?? 120;

  if (!task) {
    envelop.payload = { ok: false, error: "需要 task 参数" };
    return envelop;
  }

  // ============================================================
  // 配置
  // ============================================================

  const cfg = agent.config ?? {};
  const cliPath = cfg.aicp_cli_path ?? "E:/aicp-Engin/aicp.py";
  const pythonCmd = cfg.python_cmd ?? "python";
  const cliCwd = cfg.aicp_cli_cwd ?? "E:/aicp-Engin";

  const models = cfg.models ?? {};
  const llmConfigJson = JSON.stringify(models);

  // ============================================================
  // 写 LLM 配置到临时文件
  // ============================================================

  const tmpConfigFile = `${tmpdir()}/aicp_llm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`;

  try {
    await Bun.write(tmpConfigFile, llmConfigJson);
  } catch (e: any) {
    envelop.payload = { ok: false, error: `Failed to write temp config: ${e.message}` };
    return envelop;
  }

  // ============================================================
  // 调 CLI
  // ============================================================

  try {
    const proc = Bun.spawn(
      [
        pythonCmd,
        cliPath,
        "--exec", task,
        "--json",
        "--llm-config-file", tmpConfigFile,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        cwd: cliCwd,
      }
    );

    const timer = setTimeout(() => {
      try { proc.kill(); } catch {}
    }, timeout * 1000);

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    clearTimeout(timer);

    try { await Bun.file(tmpConfigFile).delete(); } catch {}

    const trimmed = stdout.trim();

    if (exitCode !== 0) {
      try {
        const result = JSON.parse(trimmed);
        envelop.payload = {
          ok: false,
          data: result.data ?? null,
          error: result.error ?? stderr.slice(0, 500),
        };
      } catch {
        envelop.payload = {
          ok: false,
          error: `CLI exit ${exitCode}: ${(stderr || stdout).slice(0, 500)}`,
        };
      }
      return envelop;
    }

    try {
      const result = JSON.parse(trimmed);
      envelop.payload = {
        ok: result.ok ?? false,
        data: result.data ?? null,
        error: result.error ?? "",
      };
    } catch (e: any) {
      envelop.payload = {
        ok: false,
        error: `Invalid JSON from CLI: ${trimmed.slice(0, 200)}`,
      };
    }

    return envelop;
  } catch (e: any) {
    try { await Bun.file(tmpConfigFile).delete(); } catch {}
    envelop.payload = { ok: false, error: `CLI call failed: ${e.message}` };
    return envelop;
  }
}

function tmpdir(): string {
  return process.env.TEMP ?? process.env.TMP ?? "/tmp";
}

export function help() {
  return {
    route: "builtins/tools/aicp_cli",
    description: "本地逃生通道 — 用 Bun.spawn 调本地 Python CLI",
    input: {
      action: "exec（默认）",
      task: "需求描述（自然语言）",
      timeout: "超时秒数（默认 120）",
    },
    output: {
      ok: "是否成功",
      data: "CLI 返回的结果",
      error: "错误信息",
    },
  };
}