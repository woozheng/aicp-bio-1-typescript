/**
 * contract_agent — 契约智能体
 * ==========================
 * 专用 LLM，只做一件事：读源码，提取契约
 * - 有 .contract.json 且 source_hash 一致：直接返回（落盘缓存）
 * - 无契约 或 hash 不一致：读源码 → LLM 提取 → 保存 .contract.json
 * - LLM 提取失败：返回 fallback（正则粗扫 action 名单）
 * - 提取契约时只读源码，不解析 @AICP_ALIGN 注释
 * - 返回：契约（不含源码片段）
 * - get_tools：返回 Function Calling tools schema
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Envelop } from "../../../core/Envelop.js";
import type { Agent } from "../../../core/Agent.js";

// ============================================================
// 常量
// ============================================================

const PLUGINS_ROOT = "src/plugins";

// ============================================================
// 专用 LLM 的 System Prompt
// ============================================================

const CONTRACT_EXTRACTOR_PROMPT = `你是一个契约提取专家。你的唯一任务：读插件源码，提取标准契约。

## 你收到的源码是完整的插件文件（包含 execute 函数和所有 helper 函数）

## 你的工作方式

### 第一步：定位 execute 函数
找到 async def execute(envelop, agent): 函数。这是插件的唯一入口。
（TS 版是 export async function execute(envelop, agent)）

### 第二步：提取所有 action 名称
扫描 execute 函数内的 action 分发逻辑：
- if action == 'xxx': 提取 xxx
- elif action == 'yyy': 提取 yyy
- match action: case 'zzz': 提取 zzz
- 字典路由 actions = {'aaa': handler} 提取 aaa
- TS: if (action === 'xxx') / switch (action) { case 'xxx': }

去重，列出所有 action。

### 第三步：逐个 action 提取参数【必须！不能省略！】
对每个 action 的代码块，扫描 envelop.payload 的引用：
- payload['xxx'] 是必填参数
- payload.get('xxx') 是非必填参数
- payload.get('xxx', 默认值) 是非必填，有默认值
- TS: envelop.payload.xxx / envelop.payload?.xxx / (envelop.payload as any).xxx

【重要】如果 action 的参数不在 execute 函数里，而是在 helper 函数里（如 _scan、_call 等），
也要提取这些 helper 函数的参数。每个 action 必须列出所有参数，不能为空！

参数类型推断规则：
- 默认值是数字 → number
- 默认值是字符串 → string
- 默认值是 True/False → boolean
- 默认值是 [] → array
- 默认值是 {} → object
- 猜不出来 → string

### 第四步：提取返回字段【必须！不能省略！】
找到 return envelop 之前的 envelop.payload = {...}，提取所有顶层 key。
如果返回结构在 helper 函数里，也要提取。

### 第五步：生成标准契约
按标准 schema 输出：

{
  "plugin": "插件路由名",
  "actions": {
    "action名": {
      "description": "功能描述（一句话）",
      "params": [
        {"name": "参数名", "required": true/false, "type": "类型", "desc": "参数说明"}
      ],
      "returns": [
        {"name": "返回字段", "type": "类型", "desc": "说明"}
      ],
      "notes": "补充说明（可选）",
      "pitfalls": "坑点提醒（可选）"
    }
  }
}

## 完整示例（few-shot）

### 输入源码（节选）

\`\`\`typescript
export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const action = envelop.payload?.action ?? "get_map";

  if (action === "get_map") {
    const pluginNames = await fetchPluginNames(agent);
    envelop.payload = {
      ok: true,
      summary: summaryLines.join("\\n"),
      data: { total_plugins, total_frontend, frontend, projects },
    };
    return envelop;
  }

  if (action === "list_plugins") {
    const pluginNames = await fetchPluginNames(agent);
    envelop.payload = {
      ok: true,
      plugins: pluginNames,
      total: pluginNames.length,
    };
    return envelop;
  }

  envelop.payload = { ok: false, error: \`未知 action: \${action}\` };
  return envelop;
}
\`\`\`

### 期望输出

\`\`\`json
{
  "plugin": "builtins/agents/cogitor",
  "actions": {
    "get_map": {
      "description": "获取系统概览（后端插件 + 前端系统）",
      "params": [],
      "returns": [
        {"name": "ok", "type": "boolean", "desc": "是否成功"},
        {"name": "summary", "type": "string", "desc": "系统概览文本"},
        {"name": "data", "type": "object", "desc": "结构化数据（total_plugins / total_frontend / frontend / projects）"}
      ]
    },
    "list_plugins": {
      "description": "列出所有后端插件名",
      "params": [],
      "returns": [
        {"name": "ok", "type": "boolean", "desc": "是否成功"},
        {"name": "plugins", "type": "array", "desc": "插件名列表"},
        {"name": "total", "type": "number", "desc": "插件总数"}
      ]
    }
  }
}
\`\`\`

## 核心原则

1. 源码是唯一真相——不要猜，所有信息从源码提取
2. 准确优先——action 名和参数名必须 100% 准确
3. 完整覆盖——不要遗漏任何 action 和参数
4. 参数和返回值不能为空——如果源码里有，必须提取出来
5. 保守估计——不确定的类型标 string，不确定的必填性标非必填

## 输出格式

你只输出 JSON，不要包含任何其他文字。`;

// ============================================================
// 契约 → Function Calling tools 转换
// ============================================================

const TYPE_MAP: Record<string, string> = {
  string: "string",
  number: "number",
  integer: "number",
  boolean: "boolean",
  array: "array",
  object: "object",
};

function contractToTools(pluginName: string, contract: any): any[] {
  const tools: any[] = [];
  const actions = contract?.actions ?? {};

  for (const [actionName, actionDef] of Object.entries<any>(actions)) {
    const properties: Record<string, any> = {};
    const required: string[] = [];

    for (const param of actionDef?.params ?? []) {
      const paramName = param?.name ?? "";
      if (!paramName) continue;

      const paramType = TYPE_MAP[param?.type ?? "string"] ?? "string";
      const paramDesc = param?.desc ?? "";

      const prop: any = {
        type: paramType,
        description: paramDesc,
      };

      if (paramType === "array") {
        prop.items = { type: "string" };
      }

      properties[paramName] = prop;
      if (param?.required) required.push(paramName);
    }

    tools.push({
      type: "function",
      function: {
        name: `${pluginName}::${actionName}`,
        description: actionDef?.description ?? "",
        parameters: {
          type: "object",
          properties,
          required,
        },
      },
    });
  }

  return tools;
}

// ============================================================
// LLM 提取契约
// ============================================================

async function callLlmExtract(
  agent: Agent,
  pluginName: string,
  sourceCode: string
): Promise<{ ok: boolean; contract?: any; error?: string; raw?: string }> {
  // ★ 只在实际调用 LLM 前检查
  if (!agent.llm) {
    return { ok: false, error: "LLM 未配置" };
  }

  const prompt =
    CONTRACT_EXTRACTOR_PROMPT +
    "\n\n## 插件源码（完整文件）\n\n插件路径：" +
    pluginName +
    "\n\n" +
    sourceCode +
    "\n\n请提取契约，只输出 JSON。";

  try {
    const result = await agent.llm.chat_json(
      [{ role: "user", content: prompt }],
      undefined,
      "code"
    );

    // chat_json 失败：LLM 错误串
    if (result?.error) {
      return { ok: false, error: String(result.error), raw: result.content };
    }

    // chat_json 失败：JSON 解析失败
    if (result?.parse_error) {
      return {
        ok: false,
        error: `JSON 解析失败: ${result.parse_error}`,
        raw: result.content,
      };
    }

    // 结构校验：必须有 actions 且非空
    if (
      !result?.actions ||
      typeof result.actions !== "object" ||
      Object.keys(result.actions).length === 0
    ) {
      return {
        ok: false,
        error: "LLM 返回缺少 actions 字段或为空",
        raw: JSON.stringify(result).slice(0, 500),
      };
    }

    result.plugin = result.plugin ?? pluginName;
    return { ok: true, contract: result };
  } catch (e: any) {
    return { ok: false, error: `LLM 调用失败: ${e?.message ?? e}` };
  }
}

// ============================================================
// 路径工具
// ============================================================

function pluginPaths(pluginName: string): { src: string; contract: string } {
  let name = pluginName;
  if (name.endsWith(".ts")) name = name.slice(0, -3);
  else if (name.endsWith(".js")) name = name.slice(0, -3);
  else if (name.endsWith(".py")) name = name.slice(0, -3);

  return {
    src: join(PLUGINS_ROOT, `${name}.ts`),
    contract: join(PLUGINS_ROOT, `${name}.contract.json`),
  };
}

async function readSource(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function readContract(path: string): Promise<any | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

async function saveContract(path: string, contract: any): Promise<string> {
  try {
    await writeFile(path, JSON.stringify(contract, null, 2), "utf-8");
    return path;
  } catch (e: any) {
    return `保存失败: ${e?.message ?? e}`;
  }
}

// ============================================================
// ★ 源码 hash
// ============================================================

function calcSourceHash(sourceCode: string): string {
  return createHash("md5").update(sourceCode, "utf-8").digest("hex");
}

// ============================================================
// ★ Fallback 契约（LLM 提取失败时用）
// ============================================================

/**
 * LLM 提取失败时的 fallback：用正则粗扫源码，提取 action 名单。
 *
 * 覆盖：
 * - TS: if (action === "xxx") / switch (action) { case "xxx": }
 * - Python: if action == "xxx" / elif action == "yyy"
 *
 * 提取不到时返回空 actions，至少让主 Agent 知道"有插件但没契约"。
 */
function buildFallbackContract(pluginName: string, sourceCode: string): any {
  const actions: Record<string, any> = {};

  // TS: if (action === "xxx") / if (action == "xxx")
  const tsIfRegex = /if\s*\(\s*action\s*===?\s*["']([^"']+)["']\s*\)/g;
  // TS: case "xxx":
  const tsCaseRegex = /case\s+["']([^"']+)["']\s*:/g;
  // Python: if action == "xxx" / elif action == "yyy"
  const pyIfRegex = /(?:if|elif)\s+action\s*==\s*["']([^"']+)["']/g;

  const collect = (regex: RegExp) => {
    let m: RegExpExecArray | null;
    // 每次用新 regex 避免 lastIndex 状态污染
    const re = new RegExp(regex.source, regex.flags);
    while ((m = re.exec(sourceCode)) !== null) {
      const name = m[1];
      if (name && !actions[name]) {
        actions[name] = {
          description: "(fallback: LLM extraction failed)",
          params: [],
          returns: [],
          notes: "此契约由正则粗扫生成，可能不完整。建议修复后 refresh。",
        };
      }
    }
  };

  collect(tsIfRegex);
  collect(tsCaseRegex);
  collect(pyIfRegex);

  return {
    plugin: pluginName,
    actions,
    _fallback: true,
    _fallback_note:
      "LLM 提取失败，此契约由正则粗扫生成，action 名单可能不全，参数和返回值缺失。建议检查插件源码后调用 refresh。",
  };
}

// ============================================================
// 主入口
// ============================================================

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const action = envelop.payload?.action ?? "get";
  let pluginName = (envelop.payload?.plugin ?? "").trim();

  if (!pluginName) {
    envelop.payload = { ok: false, error: "缺少 plugin 参数" };
    return envelop;
  }

  // 统一去后缀
  if (pluginName.endsWith(".py")) pluginName = pluginName.slice(0, -3);
  else if (pluginName.endsWith(".ts")) pluginName = pluginName.slice(0, -3);

  const { src: pluginFile, contract: contractFile } = pluginPaths(pluginName);

  // ============================================================
  // action: get — 返回标准契约
  // ============================================================
  if (action === "get") {
    const sourceCode = await readSource(pluginFile);
    if (sourceCode === null) {
      envelop.payload = { ok: false, error: `插件源码不存在: ${pluginFile}` };
      return envelop;
    }

    // ★ 算当前源码 hash
    const currentHash = calcSourceHash(sourceCode);

    // ★ 有契约文件，且 hash 一致 → 直接返回
    const existing = await readContract(contractFile);
    if (existing && existing.source_hash === currentHash) {
      envelop.payload = {
        ok: true,
        plugin: pluginName,
        contract: existing,
        source: "existing_contract",
        contract_file: contractFile,
      };
      return envelop;
    }

    // ★ 契约缺失 或 hash 不一致 → 重新提取
    if (existing && existing.source_hash !== currentHash) {
      console.log(`[contract_agent] source changed, re-extracting: ${pluginName}`);
    }

    const result = await callLlmExtract(agent, pluginName, sourceCode);
    const payload: any = { ...result, plugin: pluginName };

    if (result.ok) {
      // ★ 写入 source_hash
      result.contract.source_hash = currentHash;
      payload.contract_saved = await saveContract(contractFile, result.contract);
      payload.source = "llm_extraction";
    } else {
      // ★ 提取失败 → fallback
      payload.source = "extraction_failed";
      payload.fallback = buildFallbackContract(pluginName, sourceCode);
    }

    envelop.payload = payload;
    return envelop;
  }

  // ============================================================
  // action: get_tools — 返回 Function Calling tools schema
  // ============================================================
  if (action === "get_tools") {
    const sourceCode = await readSource(pluginFile);
    if (sourceCode === null) {
      envelop.payload = { ok: false, error: `插件源码不存在: ${pluginFile}` };
      return envelop;
    }

    // ★ 算当前源码 hash
    const currentHash = calcSourceHash(sourceCode);

    let contract: any = null;
    let source = "";

    // 1. 优先读契约文件，且 hash 一致
    const existing = await readContract(contractFile);
    if (existing && existing.source_hash === currentHash) {
      contract = existing;
      source = "existing_contract";
    }

    // 2. 契约缺失 或 hash 不一致 → LLM 提取并保存
    if (contract === null) {
      const result = await callLlmExtract(agent, pluginName, sourceCode);
      if (!result.ok) {
        // ★ 提取失败 → fallback
        const fallback = buildFallbackContract(pluginName, sourceCode);
        envelop.payload = {
          ok: true,
          plugin: pluginName,
          tools: contractToTools(pluginName, fallback),
          source: "fallback",
          extraction_error: result.error,
        };
        return envelop;
      }
      result.contract.source_hash = currentHash;
      contract = result.contract;
      source = "llm_extraction";
      await saveContract(contractFile, contract);
    }

    // 3. 转 tools
    const tools = contractToTools(pluginName, contract);

    envelop.payload = {
      ok: true,
      plugin: pluginName,
      tools,
      source,
      contract_file: contractFile,
    };
    return envelop;
  }

  // ============================================================
  // action: get_execute_only — 返回 execute 函数源码
  // ============================================================
  if (action === "get_execute_only") {
    const sourceCode = await readSource(pluginFile);
    if (sourceCode === null) {
      envelop.payload = { ok: false, error: `插件源码不存在: ${pluginFile}` };
      return envelop;
    }

    const lines = sourceCode.split("\n");
    let executeStart = -1;
    let executeEnd = -1;

    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i].trim();

      if (
        executeStart === -1 &&
        (stripped.includes("async function execute") ||
          stripped.includes("function execute"))
      ) {
        executeStart = i;
        continue;
      }

      if (executeStart !== -1) {
        // 下一个顶层 export / function / class 作为结束
        if (
          (stripped.startsWith("export ") ||
            stripped.startsWith("async function ") ||
            stripped.startsWith("function ") ||
            stripped.startsWith("class ")) &&
          !stripped.includes("execute")
        ) {
          executeEnd = i;
          break;
        }
      }
    }

    let executeCode: string;
    if (executeStart === -1) executeCode = sourceCode;
    else if (executeEnd === -1) executeCode = lines.slice(executeStart).join("\n");
    else executeCode = lines.slice(executeStart, executeEnd).join("\n");

    envelop.payload = {
      ok: true,
      plugin: pluginName,
      source_snippet: executeCode,
    };
    return envelop;
  }

  // ============================================================
  // action: refresh — 强制重新提取契约
  // ============================================================
  if (action === "refresh") {
    const sourceCode = await readSource(pluginFile);
    if (sourceCode === null) {
      envelop.payload = { ok: false, error: `插件源码不存在: ${pluginFile}` };
      return envelop;
    }

    const currentHash = calcSourceHash(sourceCode);
    const result = await callLlmExtract(agent, pluginName, sourceCode);
    const payload: any = { ...result, plugin: pluginName };

    if (result.ok) {
      result.contract.source_hash = currentHash;
      payload.contract_saved = await saveContract(contractFile, result.contract);
      payload.source = "refreshed";
    } else {
      payload.source = "extraction_failed";
      payload.fallback = buildFallbackContract(pluginName, sourceCode);
    }

    envelop.payload = payload;
    return envelop;
  }

  envelop.payload = { ok: false, error: `未知 action: ${action}` };
  return envelop;
}

// ============================================================
// help
// ============================================================

export function help() {
  return {
    route: "builtins/agents/contract_agent",
    description:
      "契约智能体 — 有契约且 hash 一致直接返回，无契约或 hash 不一致则 LLM 提取",
    input: {
      action: "get | get_tools | get_execute_only | refresh",
      plugin: "插件路由名（如 builtins/agents/cogitor）",
    },
    output: {
      ok: "是否成功",
      contract: "标准契约 JSON（含 source_hash）",
      tools: "Function Calling tools schema",
      source:
        "existing_contract | llm_extraction | refreshed | extraction_failed | fallback",
      contract_file: "契约文件路径",
    },
  };
}