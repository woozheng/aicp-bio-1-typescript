# AICP-BIO-1 · TypeScript

[English](README.md) | 中文

AICP-BIO-1 是一个端到端的自举、自演化 AI Agent 系统，由 [AICP 协议](https://github.com/woozheng/aicp) 驱动。

> 一切皆 Agent。协议驱动。信息流决定系统的样子。

> TypeScript 实现。另有 [Python 实现](https://github.com/woozheng/aicp-bio-1-python)。

## 核心

- **端到端**：从用户需求到可运行应用，全链路自动化
- **协议驱动**：只有一个协议 —— `execute(envelop, agent) → envelop`
- **一切皆 Agent**：工具、Agent、HTTP 入口、WebSocket、定时器，全是 Agent
- **自举**：Agent 能创建 Agent
- **自演化**：Agent 能修复 Agent
- **信息流驱动**：系统的状态在 flow 里，不在代码里

## 运行

```bash
git clone https://github.com/woozheng/aicp-bio-1-ts.git
cd aicp-bio-1-ts

```
拷贝  aicp.yaml.example--> aicp.yaml
填写相关模型参数

```bash
bun install
bun run src/main.ts
```

访问 http://127.0.0.1:9000


## 模型选择

AICP-BIO-1 需要一个**强代码能力**的模型。推荐以下两个（本人实测）：

| 模型 | Provider | 特点 |
|---|---|---|
| `doubao-code-2.0` | 火山引擎 / Aggregator | 代码能力强，速度快，便宜 |
| `claude-sonnet-4.6` | Anthropic / Aggregator | 代码能力顶级，推理稳定 |

⚠️ **推荐模型能力必须 ≥ 这两个。**

低于这个能力的模型，可能在以下环节出问题：

- **`generate_backend` / `generate_frontend`**：生成代码容易漏字段、漏 import
- **`contract_agent`**：契约提取不准
- **`main_agent`**：JSON 输出不稳定，触发重试
- **`aicp_chat`**：沙箱代码生成容易出错

**建议直接上顶级模型。** 这个系统的瓶颈不在 token 成本，在"一次写对"。

## 端到端

从一句话需求，到可运行的应用，全程由 Agent 完成：

```
用户：帮我做个番茄钟
  ↓
main_agent 理解需求，确认细节
  ↓
生成 spec（中间表示）
  ↓
generate_backend 生成后端 Agent
  ↓
generate_frontend 生成前端页面
  ↓
热重载，应用上线
  ↓
用户访问 /番茄钟/，可用
```

没有"人写代码"这一步。需求进，应用出。

## 递归自我改进（RSI）

AICP-BIO-1 是一个递归自我改进（RSI）的系统。

不是 "AI 改进 AI"，是 "AI 改进 AI 的运行环境"。

改进发生在三个层次：

1. **任务级：自递归** - main_agent 每轮读 flow，决策，写 flow，递归。失败时重试，直到完成。
2. **会话级：经验沉淀** - 任务完成后沉淀经验、技能、看板。下次遇到类似任务，复用。
3. **系统级：Agent 自举** - main_agent 能创建、修复、删除 Agent。系统的能力边界自我扩展。

基础模型不变，系统能力指数增长。

这是"工程级 RSI"，比"智能级 RSI"更"可控"。

## 架构

```
┌──────────────────────────────────────┐
│  外部状态（flow / data / config）    │
└──────────────────────────────────────┘
                ↕
┌──────────────────────────────────────┐
│  Agent（纯函数）                     │
│  execute(envelop, agent) → envelop   │
└──────────────────────────────────────┘
                ↕
┌──────────────────────────────────────┐
│  Envelop（消息） + Agent（能力）      │
└──────────────────────────────────────┘
```

- **Envelop**：消息平面（sender / receiver / payload / meta）
- **Agent**：能力平面（llm / config / system / data_dir / log）
- **插件**：两平面的交点

## 一切皆 Agent

一个 Agent 就是：

```
execute(envelop, agent) → envelop
```

没有例外。系统里所有东西都是 Agent：

| 是什么 | Agent 路由 |
|--------|------------|
| 文件读写 | os/file_utils_api |
| 主控制台 | builtins/agents/main_agent |
| 契约提取 | builtins/agents/contract_agent |
| 系统地图 | builtins/agents/cogitor |
| 代码生成 | builtins/studio/engine/generate_backend |
| 创建 Agent | builtins/tools/create_tool |
| 修复 Agent | builtins/tools/fix_tool |
| 删除 Agent | builtins/tools/remove_tool |
| 分身管理 | builtins/tools/task_manager |
| HTTP 入口 | os/_gateway |
| WebSocket | os/_websocket |
| 定时器 | os/_cron |
| 文件接收器 | os/_file_receiver |
| 静态服务 | os/_static |
| 插件注册表 | os/_registry |
| 前端页面 | www/项目名 |

连 HTTP 服务器、WebSocket 服务器、定时器都是 Agent。

## 自举

AICP-BIO-1 能创建、修复、删除 Agent：

```
main_agent 调 create_tool
  ↓
create_tool 调 generate_backend
  ↓
generate_backend 生成新 Agent（同一协议）
  ↓
新 Agent 被热重载
  ↓
main_agent 用同一 Envelop 调新 Agent
```

闭环。

## call 和 curl 同源

- **内部调用** = 构造 Envelop
- **外部 curl** = HTTP 请求，gateway 转 Envelop

两者在 Envelop 层汇合。内外无别。

## 协议

AICP-BIO-1 由 AICP 协议驱动。

协议本体只有一个：

```
execute(envelop, agent) → envelop
```

完整协议见 PROTOCOL.md。

## 其他实现

Python：[aicp-bio-1-python](https://github.com/woozheng/aicp-bio-1-python)
Java：[aicp-bio-1-java](https://github.com/woozheng/aicp-bio-1-java)

两个实现遵守同一协议。

## 开发者预览

AICP-BIO-1 处于开发者预览阶段，迭代迅速。会有破坏性变更。

## 引用

```bibtex
@misc{aicp-bio-1-ts-2026,
  title={AICP-BIO-1: Everything is an Agent (TypeScript)},
  author={dvwoo},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/woozheng/aicp-bio-1-ts}},
}
```

## 许可

MIT
