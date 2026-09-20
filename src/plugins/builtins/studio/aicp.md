# AICP Plugin Protocol v6.1 — TS 前后端开发规范

⛔ **STOP — READ ONLY** ⛔

You are receiving the AICP protocol for the FIRST time.
Read silently. Do NOT output any code. Do NOT generate plugins.

Reply EXACTLY: **"Protocol understood. Ready for requirements design."**

Then WAIT for the user's first requirement before writing.

---

## PART 0: AICP Core Concepts

### Three Atomic Units

**Envelop — The only data carrier**

Structure: `{sender, receiver, intent, payload, trace_id, message_id, channel_id, ttl, meta}`

- Plugins only read & write `payload` / `meta`
- Assign `receiver` to route execution to another plugin
- Return `null` to terminate execution flow
- `intent`: Fill empty string `""` if no intent-based routing logic

**Plugin — Processing unit**

Signature:

```typescript
export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop>
```

Return envelop（或 null）

**Agent — Engine injected capability container**

**Communication Layer Separation**

| Caller | Target | Standard Calling Method | Envelop Handling Rule | Hard Ban |
|--------|--------|-------------------------|----------------------|----------|
| Backend Plugin | Other Backend Plugin | `agent.system.call(new Envelop({...}))` | Manually fill all Envelop fields completely | Do NOT call internal plugins via HTTP `/api/...` |
| Frontend HTML Page | Backend Plugin | `POST /api/applications/{project}/{pluginName}` | Frontend only submit business JSON payload; Gateway auto fills sender/receiver/trace_id/channel_id/ttl/meta, auto assemble full Envelop; Only return `envelop.payload` as HTTP response | 1. Do NOT manually construct full Envelop<br>2. Do NOT directly request raw `/api/envelop` entry |
| External Third-party HTTP Client | Backend Plugin | `POST /api/builtins/aicpEnvelop` | Manually submit complete standard Envelop JSON | Built-in frontend pages are forbidden to use this entry |

**Gateway Auto Assembly Logic for Frontend Requests**

When frontend requests `POST /api/applications/{project}/{xxx}`:

- Auto set `sender = "frontend"`
- Auto assemble `receiver = applications/{project}/{xxx}`
- Auto generate unique `trace_id` / `message_id`
- Auto assign `channel_id = {project}_dashboard`
- Default `ttl = 10`, default `meta = {}`
- Frontend request body JSON is fully assigned to `envelop.payload`
- After plugin execution, gateway strips all Envelop fields except `payload` and returns to frontend

**System Architecture**

| Port | Service | Core Plugin | Description |
|------|---------|-------------|-------------|
| base port | HTTP API + Static Resource | `os/_gateway` | Business JSON API, static HTML/CSS/JS distribution, Envelop routing dispatch |
| port + 1 | WebSocket Real-time | `os/_websocket` | Bidirectional real-time broadcast |
| port + 2 | Large File Upload | `os/_file_receiver` | Multipart form-data upload for files over 1MB |

**Agent Built-in Capabilities**

| Tool | Return Type | Function Description |
|------|-------------|----------------------|
| `agent.llm.chat(messages)` | `Promise<string>` | Normal LLM text completion |
| `agent.llm.chat_json(messages)` | `Promise<object>` | LLM forced return parsed JSON object |
| `agent.llm.chat_stream(messages)` | `AsyncGenerator<string>` | Streaming chunk LLM output |
| `agent.system.call(envelop)` | `Promise<Envelop \| null>` | Cross-plugin synchronous call |
| `agent.scheduler.create_timer(seconds, callback)` | `timer_id` | Create delayed background timer task |

**Agent Base Read-only Properties**

| Property | Type | Description |
|----------|------|-------------|
| `agent.config` | object | Global engine system configuration |
| `agent.log` | Logger | Log output object (error/warn/info) |
| `agent.data_dir` | string | Persistent data root directory |
| `agent.base_url` | string | Engine frontend base URL prefix |

**Return Value Convention**

所有插件返回的 `envelop.payload` 必须带 `ok` 字段：

- 成功：`{ ok: true, data: ..., ... }`
- 失败：`{ ok: false, error: "...", ... }`

前端和调用方根据 `ok` 判断成功与否。

---

## PART 1: Plugin Standard Execution Patterns

### Pattern 1: Single LLM Chat

```typescript
export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const llm = agent.llm;
  if (!llm) {
    envelop.payload = { ok: false, error: "LLM not available" };
    return envelop;
  }
  // Custom message construction & llm.chat call derived by AI
  return envelop;
}
```

### Pattern 2: Multi-step Pipeline

```typescript
export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const llm = agent.llm;
  if (!llm) {
    envelop.payload = { ok: false, error: "LLM not available" };
    return envelop;
  }
  // Step1 extract, Step2 summarize, sequential llm calls derived by AI
  return envelop;
}
```

### Pattern 3: Parallel Multi-expert Task

```typescript
export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const llm = agent.llm;
  if (!llm) {
    envelop.payload = { ok: false, error: "LLM not available" };
    return envelop;
  }
  const [a, b] = await Promise.all([taskA(), taskB()]);
  return envelop;
}
```

### Pattern 4: Multi-action Dispatch

```typescript
export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const action = envelop.payload?.action ?? "default";
  let params = envelop.payload?.params ?? {};
  if (Object.keys(params).length === 0) {
    params = { ...envelop.payload };
    delete params.action;
  }

  if (action === "send") {
    // logic derived by AI
    return envelop;
  }
  if (action === "reset") {
    envelop.payload = { ok: true, history: [] };
    return envelop;
  }
  envelop.payload = { ok: false, error: `未知 action: ${action}` };
  return envelop;
}
```

### Pattern 5: Non-LLM Proxy / Webhook

```typescript
export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  // Raw data forward logic derived by AI
  return envelop;
}
```

### Pattern 6: Cross-plugin Routing

```typescript
export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  // PROJECT 必须在 execute 内部取（envelop 是参数）
  const PROJECT = envelop.receiver.split("/")[1] ?? "";

  const action = envelop.payload?.action;
  if (action === "tick") {
    envelop.receiver = `applications/${PROJECT}/tick`;
    return envelop;
  }
  return envelop;
}
```

### Pattern 7: Streaming SSE Output

```typescript
export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const action = envelop.payload?.action ?? "stream";

  if (action === "stream") {
    const llm = agent.llm;
    if (!llm) {
      envelop.payload = { ok: false, error: "LLM not available" };
      return envelop;
    }

    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: envelop.payload?.content ?? "" },
    ];

    const stream = llm.chat_stream(messages);

    // async generator → Gateway 自动转换为 SSE
    async function* sseGenerator() {
      for await (const chunk of stream) {
        if (chunk) yield chunk;
      }
      yield "[DONE]";
    }

    envelop.payload = sseGenerator();
    return envelop;
  }

  envelop.payload = { ok: false, error: `未知 action: ${action}` };
  return envelop;
}
```

说明：Gateway 检测到 `envelop.payload` 是 async generator，自动转换为 SSE 流。前端用 `ReadableStream` 接收。

### Pattern 8: Cross-plugin Call (agent.system.call)

```typescript
export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const PROJECT = envelop.receiver.split("/")[1] ?? "";

  // 跨插件调用：完整填写 Envelop 所有字段
  const result = await agent.system.call(new Envelop({
    sender: `applications/${PROJECT}/processor`,
    receiver: `applications/${PROJECT}/analyzer`,
    intent: "",
    payload: { file_path: envelop.payload?.file_path ?? "", action: "analyze" },
    trace_id: "",
    message_id: "",
    channel_id: "",
    ttl: 10,
    meta: {},
  }));

  if (!result?.payload?.ok) {
    envelop.payload = { ok: false, error: result?.payload?.error ?? "调用失败" };
    return envelop;
  }

  envelop.payload = { ok: true, data: result.payload.data };
  return envelop;
}
```

说明：`trace_id` / `message_id` / `channel_id` 留空，引擎自动补全。

---

## PART 2: Mandatory Plugin Hard Rules

### 2.1 Function Signature Rule

```typescript
export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop>
```

- `envelop.payload` is mutable object for state read/write
- Return `null` to discard request without response

统一 action 风格：

```typescript
const action = envelop.payload?.action ?? "default";
let params = envelop.payload?.params ?? {};
if (Object.keys(params).length === 0) {
  params = { ...envelop.payload };
  delete params.action;
}
```

### 2.2 Import Restriction

- 禁止 `import ... from "core"` / 任何内部 AICP 模块
- `Envelop` / `Agent` 从 `../../../core/` 导入（相对路径）
- `envelop` 和 `agent` 由引擎注入，无需手动 import

正确路径示例：

```typescript
// src/plugins/applications/{project}/api.ts（3 层深，用 ../../../）
import type { Envelop } from "../../../core/Envelop.js";
import type { Agent } from "../../../core/Agent.js";

// src/plugins/www/{project}.ts（2 层深，用 ../../）
import type { Envelop } from "../../core/Envelop.js";
import type { Agent } from "../../core/Agent.js";
```

### 2.3 LLM Invoke Rule

- `agent.llm.chat()` 返回 `string`，不是 `object`
- 调用前必须 guard `if (!agent.llm) { ... }`

### 2.4 Routing Rule

- 不要 赋值 `envelop.receiver`，除非明确转发到另一个插件
- 自指 receiver 死循环，严格禁止

### 2.5 Timeout & Exception

- 引擎只管理 网络 / LLM 全局 timeout
- 不要 写手动的 `Promise.race` timeout 包装
- 所有业务异常（IO 错误 / JSON 解析失败 / 参数缺失）必须手动 try-catch 捕获
- 引擎不会自动 处理业务崩溃异常

### 2.6 File Transfer Limit

- 超过 1MB 的二进制数据不能嵌入 Envelop JSON payload
- 使用 port+2 multipart 上传，payload 中只传文件绝对路径
- 5MB 限制只适用于 base64 嵌入 JSON 的二进制

### 2.7 Static Resource Response

```typescript
envelop.payload = {
  ok: true,
  content_type: "image/jpeg",
  body: await Bun.file(filepath).arrayBuffer(),
};
return envelop;
```

---

## PART 3: Frontend Node（前端插件）规范

### 3.1 前端节点 = 插件

每个前端项目必须有两部分：

| 部分 | 路径 | 作用 |
|------|------|------|
| 前端插件 | `src/plugins/www/{project}.ts` | 节点（render + asset） |
| 前端 HTML | `www/{project}/index.html` | 实际页面 |

**receiver**：`www/{project}`

唯一机制：**占位符注入**。HTML 里用占位符，前端插件负责替换。

不做动态获取（不用 `location.pathname` / `api/ws_config`），避免 LLM 记两套。

### 3.2 前端插件模板（MUST FOLLOW）

**所有前端插件必须遵循以下模板。**

**关键点（不可省略）：**

1. **`injectPlaceholders` 是独立函数**，`render` 和 `asset` 都调
2. **`asset` 里判断扩展名**：`.html` / `.htm` 也要替换占位符
3. **不要只在 `render` 里替换**——多 HTML 项目（index.html + admin.html + ...）必须 `asset` 也替换
4. **替换后检查占位符是否残留**，残留则报错

#### 完整模板

```typescript
/**
 * www/{project} — 前端节点
 *
 * render: 返回 index.html（前台主页）
 * asset:  返回其他页面（admin.html 等）和静态资源（css/js/图片）
 *
 * ⚠️ 关键：asset 对 .html / .htm 也要替换占位符，
 *         否则 admin.html 等页面里的 __AICP_PROJECT__ 不会被替换。
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Envelop } from "../../core/Envelop.js";
import type { Agent } from "../../core/Agent.js";

const PROJECT_NAME = "{project}";
const WWW_DIR = "www";

function contentTypeOf(ext: string): string {
  switch (ext) {
    case "html":
    case "htm":
      return "text/html; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "js":
      return "application/javascript; charset=utf-8";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "svg":
      return "image/svg+xml";
    case "json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

// ★ 占位符替换（render 和 asset 都用）
function injectPlaceholders(html: string, agent: Agent): string {
  const wsUrl = agent.config?.websocket?.external_url ?? "ws://127.0.0.1:9001/ws";
  const uploadUrl = agent.config?.upload?.external_url ?? "http://127.0.0.1:9002/upload";

  html = html.replace(/__AICP_PROJECT__/g, PROJECT_NAME);
  html = html.replace(/__WS_URL__/g, wsUrl);
  html = html.replace(/__UPLOAD_URL__/g, uploadUrl);

  return html;
}

export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop> {
  const action = envelop.payload?.action ?? "render";

  // ============================================================
  // render: 读 index.html
  // ============================================================
  if (action === "render") {
    const htmlPath = join(WWW_DIR, PROJECT_NAME, "index.html");
    if (!existsSync(htmlPath)) {
      envelop.payload = { ok: false, error: `HTML 不存在: ${htmlPath}` };
      return envelop;
    }

    let html = await readFile(htmlPath, "utf-8");
    html = injectPlaceholders(html, agent);

    // 替换后检查（防止漏替换）
    if (
      html.includes("__AICP_PROJECT__") ||
      html.includes("__WS_URL__") ||
      html.includes("__UPLOAD_URL__")
    ) {
      envelop.payload = { ok: false, error: "占位符替换失败" };
      return envelop;
    }

    envelop.payload = {
      ok: true,
      content_type: "text/html; charset=utf-8",
      body: html,
    };
    return envelop;
  }

  // ============================================================
  // asset: 读其他页面（admin.html 等）和静态资源
  // ============================================================
  if (action === "asset") {
    const assetPath = envelop.payload?.path ?? "";
    const safePath = assetPath.replace(/\.\./g, "");
    const fullPath = join(WWW_DIR, PROJECT_NAME, safePath);

    if (!existsSync(fullPath)) {
      envelop.payload = { ok: false, error: `资源不存在: ${fullPath}` };
      return envelop;
    }

    const ext = fullPath.split(".").pop()?.toLowerCase() ?? "";

    // ★ 关键：HTML 文件也要替换占位符
    // 否则 admin.html 里的 __AICP_PROJECT__ 不会被替换
    if (ext === "html" || ext === "htm") {
      let html = await readFile(fullPath, "utf-8");
      html = injectPlaceholders(html, agent);

      envelop.payload = {
        ok: true,
        content_type: "text/html; charset=utf-8",
        body: html,
      };
      return envelop;
    }

    // 其他文件（css/js/图片）直接读，不替换
    const body = await readFile(fullPath);
    envelop.payload = {
      ok: true,
      content_type: contentTypeOf(ext),
      body,
    };
    return envelop;
  }

  envelop.payload = { ok: false, error: `未知 action: ${action}` };
  return envelop;
}

export function help() {
  return {
    route: "www/{project}",
    description: "{project} 前端节点",
    input: { action: "render | asset", path: "asset 时用" },
    output: { ok: "是否成功", content_type: "MIME", body: "内容" },
  };
}

```

#### 常见错误（禁止）

**❌ 只在 `render` 里替换占位符，`asset` 不替换：**

```typescript
// Wrong
if (action === "render") {
  html = html.replace(/__AICP_PROJECT__/g, PROJECT_NAME);
}
if (action === "asset") {
  const body = await readFile(fullPath);
  // 没替换 → admin.html 里的 __AICP_PROJECT__ 原样返回
  // 前端 JS 拿到 "__AICP_PROJECT__"，调用 API 时 receiver 错
}
```

**❌ `asset` 里只处理非 HTML，忘了 HTML：**

```typescript
// Wrong
if (action === "asset") {
  const body = await readFile(fullPath);
  // 直接返回，没判断 ext
}
```

**✅ 正确：抽成 `injectPlaceholders`，`render` 和 `asset` 都调，`asset` 对 HTML 也替换。**

---

### 3.3 前端 HTML 核心变量（MUST FOLLOW）

```javascript
// 1. 项目名（由前端插件注入）
var project = "__AICP_PROJECT__";

// 2. API 根前缀
var API = '/api/applications/' + project;

// 3. WebSocket URL（由前端插件注入）
var WS_URL = "__WS_URL__";
var ws = new WebSocket(WS_URL + '?channel=' + project + '_dashboard');

// 4. 文件上传 URL（由前端插件注入）
var UPLOAD_URL = "__UPLOAD_URL__";
var res = await fetch(UPLOAD_URL, { method: 'POST', body: formData });
```

注意：HTML 里禁止用 `location.pathname` / `location.port` 动态获取。

### 3.4 标准请求封装（MUST FOLLOW）

```javascript
async function request(pluginName, payload) {
  const resp = await fetch(`${API}/${pluginName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload }),
  });
  const rawText = await resp.text();
  if (!rawText) return { ok: false, error: "空响应" };
  return JSON.parse(rawText);
}
```

### 3.5 前端 CSS 限制

- 禁止 gradient / box-shadow 装饰性样式
- 布局结构 / flex 对齐 / 消息气泡逻辑是通用前端知识，AI 可自行推导

### 3.6 前端输出自检

- [ ] 项目名由 `__AICP_PROJECT__` 占位符注入
- [ ] 标准 `/api/applications/${project}` API 前缀
- [ ] 无硬编码端口（9000/9001）/ 主机（127.0.0.1 / localhost）
- [ ] WS 用 `__WS_URL__` 占位符，不用 `location.port + 1`
- [ ] 上传用 `__UPLOAD_URL__` 占位符，不用 `location.port + 2`
- [ ] 无 `location.pathname` / `location.port` 动态获取
- [ ] 无 gradient / shadow CSS

---

## PART 4: Standard Output Format Specification

### 4.1 Path Placeholder Rule

所有文件路径用 `{project}` 占位符，禁止硬编码固定项目名。

### 4.2 Unified Code Block Wrapper

所有代码块用 `=== TYPE: PATH ===` / `=== END ===` 包裹。

```
=== PLUGIN: src/plugins/applications/{project}/{filename}.ts ===
full typescript code
=== END ===

=== FRONTEND: src/plugins/www/{project}.ts ===
full frontend plugin code
=== END ===

=== HTML: www/{project}/index.html ===
full html code
=== END ===
```

### 4.3 Block Type Mapping

| Prefix Tag | Fixed Root Path |
|------------|-----------------|
| PLUGIN | `src/plugins/applications/{project}/` |
| FRONTEND | `src/plugins/www/` |
| HTML | `www/{project}/` |

### 4.4 Plugin File Naming Rule

- 业务插件：小写描述性名字，如 `api.ts` / `task_api.ts`
- 前端插件：`{project}.ts`（在 `src/plugins/www/` 下）
- HTML：`index.html`（在 `www/{project}/` 下）
- 禁止 `__init__.py` / `_init.py`（TS 版不需要）

---

## PART 5: 项目结构规范

### 5.1 完整项目结构

```
src/plugins/applications/{project}/
└── api.ts                          # 后端插件

src/plugins/www/
└── {project}.ts                    # 前端插件

www/{project}/
└── index.html                      # 前端 HTML
```

### 5.2 系统页面 vs 用户项目

| 类型 | 路径 | 命名 |
|------|------|------|
| 系统页面 | `src/plugins/www/_{name}.ts` + `www/_{name}/` | `_` 前缀 |
| 用户项目 | `src/plugins/www/{name}.ts` + `www/{name}/` | 无前缀 |

URL 映射：`www/_{name}/` → `/name/`（去掉 `_`）

---

## PART 6: Snapshot Single Source Of Truth

### Core Principle

**One unified snapshot dict serves both LLM backend calculation and frontend rendering; no separated data copies.**

### DO

- Rebuild full snapshot on every business cycle
- Share identical snapshot for AI logic & frontend WS broadcast
- Persist snapshot once per cycle only
- Push snapshot to frontend via WebSocket channel

### DO NOT

- Duplicate account/trade/asset data storage in multiple locations
- Generate different dataset for LLM and frontend separately
- Cache cross-cycle stock/state data

---

## PART 7: Common AI Output Mistakes

### ❌ Hardcode project name string

```typescript
// Wrong（模块顶层取 envelop，报错）
const PROJECT = envelop.receiver.split("/")[1] ?? "";

export async function execute(envelop, agent) { ... }

// Correct（execute 内部取）
export async function execute(envelop, agent) {
  const PROJECT = envelop.receiver.split("/")[1] ?? "";
  ...
}
```

### ❌ Hardcode WS port / host

```javascript
// Wrong
const ws = new WebSocket("ws://127.0.0.1:9001/ws");

// Correct
const ws = new WebSocket(WS_URL + '?channel=' + project + '_dashboard');
```

### ❌ Hardcode API root path

```javascript
// Wrong
fetch("/api/applications/chatbot/api");

// Correct
var API = '/api/applications/' + project;
fetch(`${API}/api`);
```

### ❌ Use location.pathname / location.port dynamic fetch

```javascript
// Wrong（TS 版禁止动态获取）
var project = window.location.pathname.split('/')[1];
var ws = new WebSocket(`ws://${location.hostname}:${+location.port + 1}/ws`);

// Correct（用占位符注入）
var project = "__AICP_PROJECT__";
var WS_URL = "__WS_URL__";
```

### ❌ Embed large binary base64 inside JSON payload

```typescript
// Wrong
envelop.payload = { file_base64: huge_encoded_string };

// Correct
envelop.payload = { file_path: "/data/xxx.file" };
```

### ❌ Split snapshot data for AI & frontend separately

```typescript
// Wrong
const ai_data = build_ai_snapshot();
const fe_data = build_frontend_snapshot();

// Correct
const snapshot = build_unified_snapshot();
```

### ❌ Forget to generate frontend plugin

```
// Wrong（只生成 HTML，前端节点不存在）
=== HTML: www/task_board/index.html ===
...
=== END ===

// Correct（HTML + 前端插件都要）必须用 text 全部包裹，中间不没有代码块

```text
=== FRONTEND: src/plugins/www/task_board.ts ===
...
=== END ===

=== HTML: www/task_board/index.html ===
...
=== END ===
```

### ❌ params 兼容时带 action 冗余

```typescript
// Wrong
let params = envelop.payload?.params ?? {};
if (Object.keys(params).length === 0) {
  params = { ...envelop.payload };  // action 也在里面
}

// Correct
let params = envelop.payload?.params ?? {};
if (Object.keys(params).length === 0) {
  params = { ...envelop.payload };
  delete params.action;  // 去掉 action
}
```

### ❌ Forget ok field in payload

```typescript
// Wrong
envelop.payload = { data: result };

// Correct
envelop.payload = { ok: true, data: result };
```

---

## PART 8: Final Pre-output Full Checklist

### Backend Plugin Check

- [ ] 签名 `export async function execute(envelop: Envelop, agent: Agent): Promise<Envelop>`
- [ ] 统一 action 风格：`const action = envelop.payload?.action ?? "default";`
- [ ] 兼容 params / 顶层两种传参，且去掉 action 冗余
- [ ] 项目名从 `envelop.receiver.split("/")[1]` 取（在 execute 内部），无硬编码
- [ ] 无内部 AICP 模块 import
- [ ] LLM 调用前有 guard `if (!agent.llm) { ... }`
- [ ] 无自指 `envelop.receiver` 死循环
- [ ] 无手动 `Promise.race` timeout 包装
- [ ] 完整 try-catch 全局异常捕获
- [ ] 目录创建用 `mkdir(dir, { recursive: true })`
- [ ] JSON 读写 try-catch，损坏文件自动重置
- [ ] 每个代码分支都返回带 payload 的 Envelop
- [ ] 所有 payload 都带 `ok` 字段
- [ ] 所有文件路径用 `{project}` 占位符
- [ ] 输出用 text md格式包裹所有，内部用`=== TYPE: PATH ===` / `=== END ===` 包裹分割


### Frontend Plugin Check

- [ ] `src/plugins/www/{project}.ts` 存在
- [ ] render 读 `www/{project}/index.html`
- [ ] render 注入 `__AICP_PROJECT__` / `__WS_URL__` / `__UPLOAD_URL__`
- [ ] render 替换后检查占位符是否残留
- [ ] asset 支持 html / css / js / png / jpg / svg / json
- [ ] content_type 对 html 是 `text/html; charset=utf-8`
- [ ] 占位符替换抽成独立函数（injectPlaceholders）
- [ ] asset 对 .html / .htm 文件也替换占位符

### Frontend HTML Check

- [ ] 项目名由 `__AICP_PROJECT__` 注入，不硬编码
- [ ] API 变量为 `/api/applications/${project}`
- [ ] WS 用 `__WS_URL__` 占位符
- [ ] 上传用 `__UPLOAD_URL__` 占位符
- [ ] 无硬编码 IP / 端口 / 主机名
- [ ] 无 `location.pathname` / `location.port` 动态获取
- [ ] 所有 API POST 调用用标准 `request()` 封装
- [ ] CSS 无 gradient / shadow 装饰性样式

### Data Consistency Check

- [ ] 单一 unified snapshot 用于后端逻辑和前端广播
- [ ] 无重复独立状态数据集存储


