/**
 * os/saver — 代码保存服务
 *
 * 从 AI 回复中提取代码块并保存到本地
 *
 * 统一 action 模式：action: "save"（默认）
 *
 * 落盘逻辑委托 runtime/atomic_write.ts，统一处理：
 * - {project} 占位符替换（路径 + 内容）
 * - 路径校正 + app_id 应用
 * - 安全检查 + 原子写
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Envelop } from "../../core/Envelop.js";
import type { Agent } from "../../core/Agent.js";
import { atomicWrite } from "../../runtime/atomic_write.js";

// ============================================================
// ACTIONS_SCHEMA
// ============================================================

export const ACTIONS_SCHEMA = {
  save: {
    description: "从 AI 回复中提取代码块并保存到本地",
    params: {
      text: { type: "string", description: "AI 回复的完整文本" },
      app_id: { type: "string", description: "项目名（可选，用于项目内落盘）" },
    },
    required: ["text"],
  },
};

// ============================================================
// 主入口
// ============================================================

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const action = envelop.payload?.action ?? "save";

  let params: any = envelop.payload?.params ?? {};
  if (Object.keys(params).length === 0) {
    params = { ...envelop.payload };
    delete params.action;
  }

  if (action !== "save") {
    envelop.payload = {
      ok: false,
      error: `未知 action: ${action}`,
      saved: [],
      count: 0,
    };
    return envelop;
  }

  try {
    const text = params.text ?? "";
    const appId = params.app_id ?? "";

    if (!text) {
      envelop.payload = {
        ok: false,
        error: "No text provided",
        saved: [],
        count: 0,
      };
      return envelop;
    }

    const result = await extractAndSaveAll(text, appId);
    envelop.payload = { ok: true, ...result };
    return envelop;
  } catch (e: any) {
    envelop.payload = {
      ok: false,
      error: e?.message ?? String(e),
      saved: [],
      count: 0,
    };
    return envelop;
  }
}

// ============================================================
// 代码清洗
// ============================================================

function cleanCode(code: string): string {
  code = code.replace(/\n?\s*={2,}\s*\w*\s*=*\s*$/, "");
  code = code.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  code = code
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n");
  return code.trim();
}

// ============================================================
// 随机 ID
// ============================================================

function randomHex(len: number): string {
  const bytes = new Uint8Array(Math.ceil(len / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, len);
}

// ============================================================
// 自动命名（TS 版）
// ============================================================

function autoName(code: string, blockType: string): string {
  if (["auto_py", "plugin", "plugin_comment"].includes(blockType)) {
    return `src/plugins/applications/auto_${randomHex(8)}/api.ts`;
  }
  if (["auto_html", "html"].includes(blockType)) {
    return `www/auto_${randomHex(8)}/index.html`;
  }
  if (
    code.includes("async function execute") ||
    code.includes("export function help")
  ) {
    return `src/plugins/applications/auto_${randomHex(8)}/api.ts`;
  }
  if (
    code.toLowerCase().includes("<!doctype html") ||
    code.toLowerCase().includes("<html")
  ) {
    return `www/auto_${randomHex(8)}/index.html`;
  }
  return "";
}

// ============================================================
// 模式定义
// ============================================================

interface PatternDef {
  pattern: RegExp;
  type: string;
  pathGroup: number | null;
  codeGroup: number;
}

const PATTERNS: PatternDef[] = [
  // 通用 AICP 块
  {
    pattern: /===\s*(\w+):\s*(\S+)\s*===\s*\n(.*?)\n=== \w+ ===/gs,
    type: "generic",
    pathGroup: 2,
    codeGroup: 3,
  },
  // 未闭合的 AICP 块
  {
    pattern:
      /===\s*(PLUGIN|FRONTEND|HTML|CSS|JS|APP|YAML):\s*(\S+)\s*===\s*\n(.*?)(?====\s*\w+:\s*\S+\s*===|$)/gs,
    type: "loose",
    pathGroup: 2,
    codeGroup: 3,
  },
  // Markdown 代码块 + 注释路径（python 风格）
  {
    pattern: /```python\s*\n#\s*(src\/plugins\/[^\s]+\.ts)\s*\n(.*?)\n```/gs,
    type: "plugin",
    pathGroup: 1,
    codeGroup: 2,
  },
  // Markdown 代码块 + 注释路径（typescript 风格）
  {
    pattern: /```typescript\s*\n\/\/\s*(src\/plugins\/[^\s]+\.ts)\s*\n(.*?)\n```/gs,
    type: "plugin",
    pathGroup: 1,
    codeGroup: 2,
  },
  // Markdown 代码块 + HTML 注释路径
  {
    pattern: /```html\s*\n<!--\s*(www\/[^\s]+\.html)\s*-->\s*\n(.*?)\n```/gs,
    type: "html",
    pathGroup: 1,
    codeGroup: 2,
  },
  // Markdown 代码块（无路径，自动命名）
  {
    pattern: /```typescript\s*\n(.*?)\n```/gs,
    type: "auto_py",
    pathGroup: null,
    codeGroup: 1,
  },
  {
    pattern: /```html\s*\n(.*?)\n```/gs,
    type: "auto_html",
    pathGroup: null,
    codeGroup: 1,
  },
];

// ============================================================
// 核心提取 + 保存
// ============================================================

interface SaveResult {
  saved: string[];
  count: number;
  errors: string[];
  message: string;
}

async function extractAndSaveAll(
  text: string,
  appId: string = ""
): Promise<SaveResult> {
  const saved: string[] = [];
  const errors: string[] = [];
  const processedPositions = new Set<number>();

  for (const p of PATTERNS) {
    const regex = new RegExp(p.pattern.source, p.pattern.flags);

    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const pos = match.index;
      if (processedPositions.has(pos)) continue;
      processedPositions.add(pos);

      try {
        let filepath: string | null = null;
        if (p.pathGroup !== null && p.pathGroup <= match.length - 1) {
          filepath = (match[p.pathGroup] ?? "").trim();
        }

        if (p.codeGroup > match.length - 1) continue;
        let code = match[p.codeGroup] ?? "";

        code = cleanCode(code);
        if (!code || code.length < 10) continue;

        if (!filepath) {
          filepath = autoName(code, p.type);
        }

        if (!filepath) continue;

        const finalPath = await atomicWrite(filepath, code, appId);
        saved.push(finalPath);
        console.log(`📁 Saved: ${finalPath}`);
      } catch (e: any) {
        errors.push(`Failed to save: ${e?.message ?? e}`);
      }
    }
  }

  console.log(
    `\n📊 Saver: ${saved.length} files saved` +
      (errors.length ? `, ${errors.length} errors` : "")
  );
  for (const f of saved) {
    console.log(`   ✅ ${f}`);
  }

  return {
    saved,
    count: saved.length,
    errors,
    message:
      `已保存 ${saved.length} 个文件` +
      (errors.length ? `, ${errors.length} 个错误` : ""),
  };
}

// ============================================================
// help
// ============================================================

export function help() {
  return {
    route: "os/saver",
    description: "从 AI 回复中提取代码块并保存到本地，支持多种格式和容错",
    input: {
      action: "save（默认）",
      text: "AI 回复的完整文本",
      app_id: "项目名（可选，用于项目内落盘）",
    },
    output: {
      ok: "是否成功",
      saved: "已保存的文件列表",
      count: "保存的文件数",
      errors: "错误列表",
      message: "结果消息",
    },
  };
}