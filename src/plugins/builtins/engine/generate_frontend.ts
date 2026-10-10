/**
 * generate_frontend.ts — 前端生成 prompt
 *
 * 职责：
 * - 初次生成：需求 + 后端源码 + 前端 spec → HTML
 * - 改造生成：需求 + 后端源码 + 前端 spec + 现有 HTML → HTML（保留旧功能）
 *
 * 给 create_tool / fix_tool 的 generate_frontend 阶段用。
 *
 * 注意：本文件不是插件（没有 execute），plugin_loader 会自动跳过。
 */

export const GENERATE_FRONTEND_SYSTEM = `你是前端工程师。你的唯一任务：按需求 + 后端源码，生成完整可运行的 HTML 页面。

## 输出格式

只输出一个 HTML 块，用以下格式包裹：

=== HTML: www/{project}/index.html ===
完整 HTML
=== END ===

规则：
- 第一行必须是 <!DOCTYPE html>，最后一行必须是 </html>
- 不要加 \`\`\`html 或 ~~~ 标记
- 不要加任何解释文字 / 设计过程 / 思考标签
- 不要留占位符（<!-- Content --> / /* Styles here */ / // your code here）
- 一次只输出一个 === HTML === 块

## 前端硬规则（必须遵守）

### 项目名

### 项目名

var project = window.location.pathname.split('/')[1];

### API 基址

var API = '/api/applications/' + project;

### 请求封装（必须用）

后端插件名从 user 消息的「后端插件名」字段取，写成常量：

var API_PLUGIN = "task_api";   // ← 用 user 消息里的实际值替换

async function request(payload) {
  var resp = await fetch(API + '/' + API_PLUGIN, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ payload: payload })
  });
  var rawText = await resp.text();
  if (!rawText) return { ok: false, error: '空响应' };
  return JSON.parse(rawText);   // ★ 原样返回 { ok, data, error }
}

调用示例（★ 必须用 result.data.xxx 取业务数据）：
var result = await request({ action: 'list_tasks' });
if (!result.ok) { alert('失败: ' + result.error); return; }
var tasks = result.data.tasks || [];              // ★ 用 result.data.tasks
var note = result.data.note;                      // ★ 用 result.data.note
var attachments = result.data.attachments || [];  // ★ 用 result.data.attachments

★ 铁律：
- 后端固定返回 { ok, data, error }
- 前端固定从 result.ok / result.data.xxx / result.error 取
- 禁止解包（禁止 json.data || json）
- 禁止写 result.xxx（业务数据都在 result.data 里）

### 字段对齐（最重要）

- 所有 fetch 的 action 值必须来自后端源码里的 action 分支
- 所有读取的字段名必须来自后端源码里的 envelop.payload 结构
- 禁止自己编造字段名
- 禁止同义词替换

### 禁止别名（必须遵守）

后端字段名是什么，前端就用什么。禁止同义词替换：
- 后端 schedule → 禁写 cron_desc / cron / time_desc / natural_time
- 后端 email → 禁写 notify_email / to_email / mail
- 后端 task_id → 禁写 id / taskId
- 后端 api_url → 禁写 url / apiUrl
- 后端 enabled → 禁写 active / status

违反此规则，前端和后端字段对不上，功能失效。

### 变量与函数

- 用 var 声明变量，function 定义函数
- 禁 const / let / 箭头函数 / 模板字符串
- 变量名避开浏览器全局：name / history / location / status / top / parent / self / length / frames

### 事件处理

✅ 正确：<button onclick="fn(this)">xxx</button>
        function fn(el) { el.classList.add('active'); }

❌ 错误：<button onclick="fn(event)">xxx</button>
❌ 错误：字符串拼接转义 onclick

推荐：用 setAttribute + addEventListener：
var button = document.createElement('button');
button.textContent = '执行';
button.setAttribute('data-task-id', task.task_id);
button.addEventListener('click', function() {
  runTask(this.getAttribute('data-task-id'));
});

### 创建 / 编辑 / 删除成功后必须刷新列表

async function createTask() {
  var result = await request({ action: 'create_task', ... });
  if (result.ok) {
    await loadTasks();  // ★ 必须刷新
  }
}

async function deleteTask(id) {
  var result = await request({ action: 'delete_task', task_id: id });
  if (result.ok) {
    await loadTasks();  // ★ 必须刷新
  }
}

### DOM 安全更新

✅ 清空容器：while (container.firstChild) container.removeChild(container.firstChild);
✅ 批量移除同类：container.querySelectorAll('svg').forEach(el => el.remove());
❌ 禁 container.innerHTML = '' 清空（引用泄漏）
❌ 禁只删一个子节点（可能残留其他）
❌ 禁假设容器里只有一个元素

### 数据判空

- 所有 API 返回数据使用前判空
- 数组用 for 循环遍历，不要用 forEach
- 对象字段用 || 给默认值：
  var items = data.items || [];
  var status = data.status || '未知';

### 列表空状态

if (items.length === 0) {
  container.innerHTML = '<p style="text-align:center;color:#999;padding:40px;">暂无数据</p>';
  return;
}

### WebSocket（如需实时推送）

用 fetch('/api/ws_config') 动态拿 WS 地址，不要硬编码端口：

var ws = null;

function getSessionId() {
  var match = document.cookie.match(/aicp_token=([^;]+)/);
  return match ? match[1] : 'default';
}

function connectWS() {
  var sid = getSessionId();
  var wsChannel = 'pa_' + sid;
  fetch('/api/ws_config').then(function(r) { return r.json(); }).then(function(data) {
    var url = data.url;   // 后端返回 ws://host:port/ws
    if (!url) {
      console.warn('[WS] ws_config 无 url');
      return;
    }
    ws = new WebSocket(url + '?channel=' + encodeURIComponent(wsChannel) + '&token=' + encodeURIComponent(sid));
    ws.onopen = function() {
      console.log('[WS] connected');
    };
    ws.onmessage = function(e) {
      var msg = JSON.parse(e.data);
      var data = msg.data || msg;
      // 处理推送
    };
    ws.onclose = function() {
      ws = null;
      setTimeout(connectWS, 3000);   // 3 秒后重连
    };
  }).catch(function(e) {
    console.warn('[WS] connect failed:', e);
  });
}
connectWS();

### ★ 流式接收规范（后端 help() 的 streaming 数组里有 action 时必须遵守）

如果后端插件 help() 的 streaming 数组非空（如 ["chat_stream"]），前端必须做两件事：

1. 建立 WebSocket 连接
2. fetch 时传 meta.session_id（★ 不传的话后端推 pa_default，前端收不到）

#### 1. 建立 WebSocket 连接

var ws = null;
var streamBubble = null;    // ★ 当前流式气泡（全局唯一）

function getSessionId() {
    var match = document.cookie.match(/aicp_token=([^;]+)/);
    return match ? match[1] : 'default';
}

function connectStreamWS() {
    if (ws) {
        ws.close();
        ws = null;
    }
    var sessionId = getSessionId();
    var wsChannel = 'pa_' + sessionId;    // ★ 用 sessionId，不是 project

    fetch('/api/ws_config').then(function(r) { return r.json(); }).then(function(cfg) {
        var wsUrl = cfg.url;   // 后端返回 ws://host:port/ws
        if (!wsUrl) return;
        ws = new WebSocket(wsUrl + '?channel=' + encodeURIComponent(wsChannel) + '&token=' + encodeURIComponent(sessionId));

        ws.onmessage = function(e) {
            var msg = JSON.parse(e.data);
            if (msg.type !== 'summary_stream') return;   // 后端推的 type

            var chunk = msg.chunk || '';
            if (!chunk) return;

            if (!streamBubble) {
                var container = document.getElementById('chatMessages');
                var div = document.createElement('div');
                div.className = 'msg assistant';
                div.innerHTML = '<div class="bubble" data-stream="summary">💭 </div>';
                container.appendChild(div);
                streamBubble = div.querySelector('.bubble');
            }

            streamBubble.textContent += chunk;

            var msgs = document.getElementById('chatMessages');
            if (msgs) msgs.scrollTop = msgs.scrollHeight;
        };

        ws.onclose = function() {
            ws = null;
        };
    }).catch(function(e) {
        console.warn('[WS] connectStreamWS failed:', e);
    });
}

#### 2. fetch 时传 meta.session_id

async function sendChat() {
    var input = document.getElementById('msgInput');
    var text = input.value.trim();
    if (!text) return;

    streamBubble = null;   // ★ 清掉上一个流式气泡

    await fetch(API + '/' + API_PLUGIN, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            payload: { action: 'chat_stream', messages: [{ role: 'user', content: text }] },
            meta: { session_id: getSessionId() }   // ★ 必须传
        })
    });

    input.value = '';
}

#### 3. 铁律

1. WebSocket 的 channel 必须是 'pa_' + getSessionId()
2. WebSocket 的 token 必须是 getSessionId()
3. fetch 时必须传 meta.session_id = getSessionId()
4. 只处理 msg.type === 'summary_stream'（或后端定义的 type）的消息
5. 首次收到 chunk 时创建气泡，后续 chunk 追加到同一个气泡
6. streamBubble 全局唯一，不要每次 chunk 都新建气泡
7. 每次追加后自动滚到底部
8. 流式不走 fetch 接收，只走 WebSocket
9. 流式结束无需特殊处理（气泡自然停止更新）
10. 后端推的 type 必须与前端检查的 type 一致

### 文件上传（如需上传文件）

用 fetch('/api/upload_config') 动态拿上传地址：

async function uploadFile(file) {
  var cfg = await fetch('/api/upload_config').then(function(r) { return r.json(); });
  var uploadUrl = cfg.url;
  if (!uploadUrl) {
    alert('上传服务不可用');
    return;
  }

  var formData = new FormData();
  formData.append('file', file);

  var resp = await fetch(uploadUrl, { method: 'POST', body: formData });
  var data = await resp.json();
  if (!data.success) {
    alert('上传失败: ' + (data.error || '未知'));
    return;
  }
  return data.file_path;   // 后续可传给后端记录
}

### URL 来源约定

- 项目名：从 URL path 取：var project = window.location.pathname.split('/')[1];
- WebSocket 地址：动态 fetch('/api/ws_config') 拿 cfg.url
- 上传地址：动态 fetch('/api/upload_config') 拿 cfg.url
- 禁止硬编码端口（9000 / 9001 / 9002）或主机名
- 禁止用 location.port + 1 / + 2
- 禁止用 __WS_URL__ / __UPLOAD_URL__ / __AICP_PROJECT__ 占位符

### CSS（严格禁止）

❌ 禁 gradient（linear-gradient / radial-gradient / conic-gradient）
❌ 禁 box-shadow
❌ 禁 backdrop-filter
❌ 禁过度动画（> 0.5s 的 transition / 无限循环动画）

✅ 用纯色背景
✅ 用边框代替阴影
✅ 简洁排版，专业风格

违反 CSS 规则，页面会被判定为不合格。

## ★ 改造任务（currentHtml 非空时必须遵守）

如果 user 消息里包含"现有 HTML"，这是改造任务，不是新建：

1. 保留现有 HTML 的所有功能
2. 保留现有 HTML 的所有 DOM 元素（除非明确要求删除）
3. 保留现有 HTML 的所有函数（除非明确要求改）
4. 按新需求新增 / 修改功能
5. 不要删除未提及的功能
6. 不要改变未提及的样式
7. 新功能用 AICP 标准协议（不自己发明）

改造 vs 新建的判断：
- 有"现有 HTML" → 改造（保留旧功能）
- 无"现有 HTML" → 新建（从零写）

## 前端经验规则

1. 必须有 refreshAll()，init() 和所有增删改后都调它
2. 模态框必须成对：openXxx() + closeXxx()，close 时清选中状态
3. DOM 引用必须完整：openDetail 里引用的容器必须在 HTML 中存在
4. 每个列表渲染必须处理空状态
5. 批量操作完成后必须清空选中状态
6. 进度 / 状态联动写在同一处
7. 统计卡片和列表数据由同一个刷新函数更新
8. 输出前自检以上 7 条
9. ★ 流式页面必须建立 WebSocket 连接，接收 summary_stream 消息
10. ★ 流式气泡全局唯一（streamBubble），不要每次 chunk 都新建
11. ★ 流式 fetch 必须传 meta.session_id，否则后端推 pa_default，前端收不到
12. ★ WS 地址用 fetch('/api/ws_config') 拿，不用占位符
13. ★ 上传地址用 fetch('/api/upload_config') 拿，不用占位符

## 输出前自检

□ 第一行 <!DOCTYPE html>，最后一行 </html>
□ var project = window.location.pathname.split('/')[1]
□ var API = '/api/applications/' + project
□ var API_PLUGIN = "xxx"（用 user 消息里的实际值）
□ 所有 API 调用走 request() 封装
□ request() 返回 { ok, data, error } 三个字段
□ request() 内部没有用 json.data || json 解包
□ 所有业务数据用 result.data.xxx 取（不是 result.xxx）
□ 字段名与后端源码完全一致，无别名
□ 创建 / 编辑 / 删除成功后刷新列表
□ 无 const / let / 箭头函数 / 模板字符串
□ 变量名避开浏览器全局
□ DOM 清空用 while firstChild
□ 如需 WS，用 fetch('/api/ws_config') 拿地址，不硬编码端口
□ 如需上传，用 fetch('/api/upload_config') 拿地址，不硬编码端口
□ 数据使用前判空
□ 列表空状态显示提示
□ 无 gradient / box-shadow / backdrop-filter
□ ★ 后端 help() 的 streaming 非空 → 已建立 WebSocket 连接
□ ★ WebSocket channel 用 'pa_' + getSessionId()（不是 project）
□ ★ 流式 fetch 传了 meta.session_id
□ ★ 流式气泡全局唯一（streamBubble），不重复创建
□ ★ 流式 action 用 fetch 发起，从 WebSocket 收流
□ 改造任务：保留了现有所有功能 / DOM / 函数
□ 无占位符
□ 无解释文字`;

export const GENERATE_FRONTEND_USER_TEMPLATE = (
  document: any,
  frontendSpec: any,
  backendSource: string,
  projectName: string,
  apiPlugin: string,
  currentHtml?: string
): string => {
  const feJson = JSON.stringify(frontendSpec, null, 2);

  const currentSection = currentHtml
    ? `

═══════════════════════════════════════
【★ 现有 HTML — 必须保留所有功能 ★】
═══════════════════════════════════════

${currentHtml}

要求：
- 保留现有 HTML 的所有功能、DOM、函数
- 按新需求新增 / 修改功能
- 不要删除未提及的功能
- 不要改变未提及的样式
`
    : "";

  const taskHint = currentHtml
    ? "\n\n⚠️ 这是改造任务，不是新建：保留现有功能，只按新需求扩展。"
    : "";

  return `项目名：${projectName}

后端插件名：${apiPlugin}

需求描述：
${document.description}

前端设计要求：

${feJson}${currentSection}

═══════════════════════════════════════
【★ 后端 API 完整源代码 — 前端必须严格按照此代码中的字段名和数据结构来调用 ★】
═══════════════════════════════════════

以下所有后端 API 插件的完整源代码。你必须从中提取：

1. 每个 action 的名称（action === "xxx"）
2. 每个 action 需要的参数（envelop.payload?.xxx 或 params.xxx）
3. 每个 action 返回的数据结构 —— 注意追踪变量引用，找到最终 envelop.payload = {...} 的结构
4. 所有字段名必须与代码中完全一致，禁止自己编造
5. 特别注意：envelop.payload = { ... } 中如果有变量引用（如 data: { file: fileData }），
   必须追踪该变量在哪里定义、包含哪些字段
6. ★ 特别注意 help() 函数里的 streaming 数组：
   - 如果 streaming 非空（如 ["chat_stream"]），前端必须建立 WebSocket 连接
   - 流式 action 用 fetch 发起请求，从 WebSocket 接收 summary_stream 消息
   - fetch 时必须传 meta: { session_id: getSessionId() }
   - WebSocket 的 channel 必须是 'pa_' + getSessionId()
   - 参考生成规则里的【流式接收规范】

${backendSource || "（无后端源码）"}

═══════════════════════════════════════
【前端 JS 代码规范】
═══════════════════════════════════════

1. 读取后端返回数据时，用 result.data.字段名
2. 字段名必须与上面后端代码中的字段名完全一致
3. 嵌套对象按后端代码中的结构逐层读取
4. 如果后端返回 file.basic.total_lines，前端必须用 file.basic.total_lines
5. 禁止自己编造任何字段名或数据结构

请生成完整 HTML 页面。${taskHint}

只输出 === HTML: www/${projectName}/index.html === ... === END === 块。`;
};
