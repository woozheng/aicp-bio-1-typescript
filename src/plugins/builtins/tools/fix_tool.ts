/**
 * fix_tool — 修复已有应用
 *
 * 统一 action 模式：action: "fix"（默认）
 *
 * 输入：target（项目名 / 路径）+ issue（修复需求，自然语言）
 *
 * 流程：
 *   1. 解析 target → 项目名
 *   2. 读项目现状（后端代码 + 前端 HTML）
 *   3. fix_design → 修复方案（mode + scope + 具体文件 + 具体改动）
 *   4. 按 mode 分流：
 *      - local：走 fix_backend / fix_frontend（局部修）
 *      - regenerate：走 generate_backend / generate_frontend（带现有代码，保留旧功能）
 *   5. 原子写
 *   6. 等 watcher 重载
 *   7. 返回
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Envelop } from "../../../core/Envelop.js";
import type { Agent } from "../../../core/Agent.js";
import { atomicWrite } from "../../../runtime/atomic_write.js";

import {
  FIX_DESIGN_SYSTEM,
  FIX_DESIGN_USER_TEMPLATE,
} from "../engine/fix_design.js";
import {
  FIX_BACKEND_SYSTEM,
  FIX_BACKEND_USER_TEMPLATE,
} from "../engine/fix_backend.js";
import {
  FIX_FRONTEND_SYSTEM,
  FIX_FRONTEND_USER_TEMPLATE,
} from "../engine/fix_frontend.js";
import {
  GENERATE_BACKEND_SYSTEM,
  GENERATE_BACKEND_USER_TEMPLATE,
} from "../engine/generate_backend.js";
import {
  GENERATE_FRONTEND_SYSTEM,
  GENERATE_FRONTEND_USER_TEMPLATE,
} from "../engine/generate_frontend.js";

// ============================================================
// 常量
// ============================================================

const PROJECTS_DIR = "src/plugins/applications";
const WWW_HTML_DIR = "www";
const MAX_BACKEND_SOURCE_CHARS = 30000;
const MAX_FILE_SUMMARY_CHARS = 2000;

// ============================================================
// 工具函数
// ============================================================

function extractPluginBlock(raw: string): string | null {
  const m = raw.match(/=== PLUGIN:\s*[^=]+===\s*\n([\s\S]*?)=== END ===/);
  if (m) return m[1].trim();
  return null;
}

function extractHtmlBlock(raw: string): string | null {
  const m = raw.match(/=== HTML:\s*[^=]+===\s*\n([\s\S]*?)=== END ===/);
  if (m) return m[1].trim();
  const m2 = raw.match(/(<!DOCTYPE html>[\s\S]*?<\/html>)/i);
  if (m2) return m2[1].trim();
  return null;
}

// ============================================================
// 项目解析（与原来相同）
// ============================================================

function parseProjectName(target: string): string {
  if (target.includes("applications/")) {
    const after = target.split("applications/").pop() ?? "";
    return after.split("/")[0] ?? "";
  }
  if (target.startsWith("www/")) {
    const after = target.slice(4);
    return after.split("/")[0] ?? "";
  }
  return target.trim();
}

async function findBackendFiles(
  projectName: string
): Promise<Array<{ path: string; fileName: string }>> {
  const backendDir = join(PROJECTS_DIR, projectName);
  if (!existsSync(backendDir)) return [];

  try {
    const files = await readdir(backendDir);
    const tsFiles = files.filter(
      (f) =>
        f.endsWith(".ts") &&
        !f.endsWith(".d.ts") &&
        !f.endsWith(".tmp") &&
        !f.endsWith(".contract.json")
    );
    return tsFiles.map((f) => ({
      path: join(backendDir, f),
      fileName: f,
    }));
  } catch {
    return [];
  }
}

async function collectBackendSource(projectName: string): Promise<string> {
  const files = await findBackendFiles(projectName);
  if (files.length === 0) return "";

  const parts: string[] = [];
  for (const f of files) {
    try {
      const code = await readFile(f.path, "utf-8");
      parts.push(`=== ${f.fileName} ===\n${code}`);
    } catch {}
  }

  let combined = parts.join("\n\n");
  if (combined.length > MAX_BACKEND_SOURCE_CHARS) {
    combined =
      combined.slice(0, MAX_BACKEND_SOURCE_CHARS) +
      "\n\n... (后端源码过长，已截断)";
  }
  return combined;
}

function extractFileSummary(code: string): string {
  const lines = code.split("\n");
  const parts: string[] = [];

  const head = lines.slice(0, 15).join("\n");
  const commentMatch = head.match(/\/\*\*([\s\S]*?)\*\//);
  if (commentMatch) {
    const comment = commentMatch[1]
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/, "").trim())
      .filter((l) => l)
      .slice(0, 5)
      .join(" | ");
    if (comment) parts.push(`注释: ${comment}`);
  }

  const exports: string[] = [];
  const exportRe = /export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = exportRe.exec(code)) !== null) {
    exports.push(m[1]);
  }
  if (exports.length > 0) {
    parts.push(`导出: ${exports.join(", ")}`);
  }

  if (parts.length === 0) {
    parts.push(lines.slice(0, 10).join("\n"));
  }

  let summary = parts.join("\n");
  if (summary.length > MAX_FILE_SUMMARY_CHARS) {
    summary = summary.slice(0, MAX_FILE_SUMMARY_CHARS) + "...";
  }
  return summary;
}

async function collectBackendFileInfos(
  projectName: string
): Promise<Array<{ fileName: string; summary: string }>> {
  const files = await findBackendFiles(projectName);
  const result: Array<{ fileName: string; summary: string }> = [];
  for (const f of files) {
    try {
      const code = await readFile(f.path, "utf-8");
      result.push({
        fileName: f.fileName,
        summary: extractFileSummary(code),
      });
    } catch {
      result.push({ fileName: f.fileName, summary: "(读取失败)" });
    }
  }
  return result;
}

// ============================================================
// LLM 调用
// ============================================================

async function callFixDesign(
  agent: Agent,
  projectName: string,
  issue: string,
  backendFileInfos: Array<{ fileName: string; summary: string }>,
  backendExists: boolean,
  frontendExists: boolean,
  backendSource: string
): Promise<any> {
  if (!agent.llm) throw new Error("LLM 未配置");

  const result = await agent.llm.chat_json(
    [
      { role: "system", content: FIX_DESIGN_SYSTEM },
      {
        role: "user",
        content: FIX_DESIGN_USER_TEMPLATE(
          projectName,
          issue,
          backendFileInfos,
          backendExists,
          frontendExists,
          backendSource
        ),
      },
    ],
    undefined,
    "code"
  );

  if (result?.error) throw new Error(`fix_design 失败: ${result.error}`);
  if (!result?.scope) throw new Error("fix_design 返回缺少 scope");
  if (!result?.mode) result.mode = "regenerate";
  return result;
}

async function callFixBackend(
  agent: Agent,
  projectName: string,
  backendFileName: string,
  issue: string,
  currentCode: string,
  backendChanges: any[]
): Promise<string> {
  if (!agent.llm) throw new Error("LLM 未配置");

  const raw = await agent.llm.chat(
    [
      { role: "system", content: FIX_BACKEND_SYSTEM },
      {
        role: "user",
        content: FIX_BACKEND_USER_TEMPLATE(
          projectName,
          backendFileName,
          issue,
          currentCode,
          backendChanges
        ),
      },
    ],
    undefined,
    "code"
  );

  const code = extractPluginBlock(raw);
  if (!code) throw new Error("无法提取后端代码");
  return code;
}

async function callFixFrontend(
  agent: Agent,
  projectName: string,
  issue: string,
  currentHtml: string,
  backendSource: string,
  frontendChanges: any[]
): Promise<string> {
  if (!agent.llm) throw new Error("LLM 未配置");

  const raw = await agent.llm.chat(
    [
      { role: "system", content: FIX_FRONTEND_SYSTEM },
      {
        role: "user",
        content: FIX_FRONTEND_USER_TEMPLATE(
          projectName,
          issue,
          currentHtml,
          backendSource,
          frontendChanges
        ),
      },
    ],
    undefined,
    "code"
  );

  const html = extractHtmlBlock(raw);
  if (!html) throw new Error("无法提取 HTML 代码");
  return html;
}

async function callGenerateBackend(
  agent: Agent,
  projectName: string,
  pluginSpec: any,
  issue: string,
  currentCode: string
): Promise<string> {
  if (!agent.llm) throw new Error("LLM 未配置");

  const raw = await agent.llm.chat(
    [
      { role: "system", content: GENERATE_BACKEND_SYSTEM },
      {
        role: "user",
        content: GENERATE_BACKEND_USER_TEMPLATE(
          { description: issue },
          pluginSpec,
          projectName,
          currentCode
        ),
      },
    ],
    undefined,
    "code"
  );

  const code = extractPluginBlock(raw);
  if (!code) throw new Error("无法提取后端代码");
  return code;
}

async function callGenerateFrontend(
  agent: Agent,
  projectName: string,
  frontendSpec: any,
  issue: string,
  backendSource: string,
  apiPlugin: string,
  currentHtml: string
): Promise<string> {
  if (!agent.llm) throw new Error("LLM 未配置");

  const raw = await agent.llm.chat(
    [
      { role: "system", content: GENERATE_FRONTEND_SYSTEM },
      {
        role: "user",
        content: GENERATE_FRONTEND_USER_TEMPLATE(
          { description: issue },
          frontendSpec,
          backendSource,
          projectName,
          apiPlugin,
          currentHtml
        ),
      },
    ],
    undefined,
    "code"
  );

  const html = extractHtmlBlock(raw);
  if (!html) throw new Error("无法提取 HTML 代码");
  return html;
}

// ============================================================
// 主入口
// ============================================================

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const action = envelop.payload?.action ?? "fix";

  let params = envelop.payload?.params ?? {};
  if (Object.keys(params).length === 0) {
    params = { ...envelop.payload };
    delete params.action;
  }

  if (action !== "fix") {
    envelop.payload = { ok: false, error: `未知 action: ${action}` };
    return envelop;
  }

  const target = params.target ?? "";
  const issue = params.issue ?? params.requirement ?? "";

  if (!target) {
    envelop.payload = { ok: false, error: "缺少 target 参数" };
    return envelop;
  }
  if (!issue) {
    envelop.payload = { ok: false, error: "缺少 issue 参数" };
    return envelop;
  }

  if (!agent.llm) {
    envelop.payload = { ok: false, error: "LLM 未配置" };
    return envelop;
  }

  const projectName = parseProjectName(target);
  if (!projectName) {
    envelop.payload = { ok: false, error: `无法解析项目名: ${target}` };
    return envelop;
  }

  if (
    projectName.includes("..") ||
    projectName.includes("/") ||
    projectName.includes("\\")
  ) {
    envelop.payload = { ok: false, error: "项目名含非法字符" };
    return envelop;
  }

  const backendFiles = await findBackendFiles(projectName);
  const backendExists = backendFiles.length > 0;

  const htmlPath = join(WWW_HTML_DIR, projectName, "index.html");
  const frontendExists = existsSync(htmlPath);

  if (!backendExists && !frontendExists) {
    envelop.payload = { ok: false, error: `项目不存在: ${projectName}` };
    return envelop;
  }

  const currentHtml = frontendExists
    ? await readFile(htmlPath, "utf-8")
    : "";

  const backendSource = backendExists
    ? await collectBackendSource(projectName)
    : "";

  const backendFileInfos = backendExists
    ? await collectBackendFileInfos(projectName)
    : [];

  // ============================================================
  // 1. fix_design
  // ============================================================

  let design: any;
  try {
    design = await callFixDesign(
      agent,
      projectName,
      issue,
      backendFileInfos,
      backendExists,
      frontendExists,
      backendSource
    );
  } catch (e: any) {
    envelop.payload = { ok: false, error: `修复方案设计失败: ${e.message}` };
    return envelop;
  }

  const mode = design.mode ?? "regenerate";
  const scope = design.scope;
  const backendChanges = design.backend_changes ?? [];
  const frontendChanges = design.frontend_changes ?? [];

  const writtenFiles: string[] = [];

  // ============================================================
  // 2. 按 mode 分流
  // ============================================================

  if (mode === "regenerate") {
    // ============================================================
    // 2A. 重生成：走 generate_*（带现有代码）
    // ============================================================

    // ---- 后端 ----
    if ((scope === "backend" || scope === "both") && backendExists) {
      for (const file of backendFiles) {
        const currentCode = await readFile(file.path, "utf-8");

        const spec = design.backend_spec ?? {
          name: file.fileName.replace(".ts", ""),
          description: issue,
        };

        let newCode: string;
        try {
          newCode = await callGenerateBackend(
            agent,
            projectName,
            spec,
            issue,
            currentCode
          );
        } catch (e: any) {
          envelop.payload = {
            ok: false,
            error: `重生成后端失败 (${file.fileName}): ${e.message}`,
          };
          return envelop;
        }

        const actualPath = await atomicWrite(file.path, newCode, projectName);
        writtenFiles.push(actualPath);
      }
    }

    // ---- 前端 ----
    if ((scope === "frontend" || scope === "both") && frontendExists) {
      const freshBackendSource = await collectBackendSource(projectName);

      const spec = design.frontend_spec ?? {
        name: "index.html",
        description: issue,
      };

      // 推断 API plugin 名（取第一个后端文件名）
      const apiPlugin = backendFiles[0]?.fileName.replace(".ts", "") ?? "";

      let newHtml: string;
      try {
        newHtml = await callGenerateFrontend(
          agent,
          projectName,
          spec,
          issue,
          freshBackendSource,
          apiPlugin,
          currentHtml
        );
      } catch (e: any) {
        envelop.payload = {
          ok: false,
          error: `重生成前端失败: ${e.message}`,
        };
        return envelop;
      }

      const actualPath = await atomicWrite(htmlPath, newHtml, projectName);
      writtenFiles.push(actualPath);
    }
  } else {
    // ============================================================
    // 2B. 局部改：走 fix_*（原逻辑）
    // ============================================================

    // ---- 后端 ----
    if ((scope === "backend" || scope === "both") && backendExists) {
      for (const change of backendChanges) {
        const fileName = change.file;
        if (!fileName) {
          if (backendFiles.length === 0) continue;
          const fallback = backendFiles[0];
          const currentCode = await readFile(fallback.path, "utf-8");
          let newCode: string;
          try {
            newCode = await callFixBackend(
              agent,
              projectName,
              fallback.fileName,
              issue,
              currentCode,
              [change]
            );
          } catch (e: any) {
            envelop.payload = {
              ok: false,
              error: `修复后端失败 (${fallback.fileName}): ${e.message}`,
            };
            return envelop;
          }
          const actualPath = await atomicWrite(fallback.path, newCode, projectName);
          writtenFiles.push(actualPath);
          continue;
        }

        const filePath = join(PROJECTS_DIR, projectName, fileName);
        if (!existsSync(filePath)) {
          envelop.payload = {
            ok: false,
            error: `后端文件不存在: ${fileName}`,
          };
          return envelop;
        }
        const currentCode = await readFile(filePath, "utf-8");
        let newCode: string;
        try {
          newCode = await callFixBackend(
            agent,
            projectName,
            fileName,
            issue,
            currentCode,
            [change]
          );
        } catch (e: any) {
          envelop.payload = {
            ok: false,
            error: `修复后端失败 (${fileName}): ${e.message}`,
          };
          return envelop;
        }
        const actualPath = await atomicWrite(filePath, newCode, projectName);
        writtenFiles.push(actualPath);
      }
    }

    // ---- 前端 ----
    if ((scope === "frontend" || scope === "both") && frontendExists) {
      const useBackendSource =
        scope === "both"
          ? await collectBackendSource(projectName)
          : backendSource;

      let newHtml: string;
      try {
        newHtml = await callFixFrontend(
          agent,
          projectName,
          issue,
          currentHtml,
          useBackendSource,
          frontendChanges
        );
      } catch (e: any) {
        envelop.payload = { ok: false, error: `修复前端失败: ${e.message}` };
        return envelop;
      }

      try {
        const actualPath = await atomicWrite(htmlPath, newHtml, projectName);
        writtenFiles.push(actualPath);
      } catch (e: any) {
        envelop.payload = { ok: false, error: `写入前端失败: ${e.message}` };
        return envelop;
      }
    }
  }

  // ============================================================
  // 3. 等 watcher 重载
  // ============================================================

  await new Promise((r) => setTimeout(r, 3000));

  // ============================================================
  // 4. 返回
  // ============================================================

  const url = frontendExists ? `/${projectName}/` : "";

  envelop.payload = {
    ok: true,
    data: {
      project_name: projectName,
      mode,
      scope,
      reason: design.reason ?? "",
      files: writtenFiles,
      backend_changes: backendChanges,
      frontend_changes: frontendChanges,
      url,
    },
    message: `✅ 修复完成：${projectName}\n模式：${mode}\n范围：${scope}${url ? `\n访问：${url}` : ""}`,
  };
  return envelop;
}

// ============================================================
// help
// ============================================================

export function help() {
  return {
    route: "builtins/tools/fix_tool",
    description: "修复已有应用（local 局部改 / regenerate 重生成）",
    input: {
      action: "fix（默认）",
      target: "项目名（如 task_board）或路径",
      issue: "修复需求（自然语言）",
    },
    output: {
      ok: "是否成功",
      data: {
        project_name: "项目名",
        mode: "local | regenerate",
        scope: "backend | frontend | both",
        reason: "判断依据",
        files: "修改的文件列表",
        backend_changes: "后端改动列表",
        frontend_changes: "前端改动列表",
        url: "前端访问地址",
      },
      message: "结果消息",
    },
  };
}