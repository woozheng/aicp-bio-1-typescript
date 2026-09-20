# AICP-BIO-1 · TypeScript

[中文](./README.zh-CN.md) | English

AICP-BIO-1 is an end-to-end, self-bootstrapping, self-evolving AI Agent system, driven by the [AICP Protocol](https://github.com/woozheng/aicp) .

> Everything is an Agent. Protocol-driven. The system is shaped by its information flow.

TypeScript implementation. See also the [Python implementation](#other-implementations).

## Highlights

- **End-to-end**: From a single user requirement to a running application, fully automated
- **Protocol-driven**: Only one protocol — `execute(envelop, agent) → envelop`
- **Everything is an Agent**: Tools, agents, HTTP gateway, WebSocket, cron — all are Agents
- **Self-bootstrapping**: Agents can create Agents
- **Self-evolving**: Agents can fix Agents
- **Information-flow driven**: System state lives in the flow, not in the code

## Run

```bash
git clone https://github.com/woozheng/aicp-bio-1-ts.git
cd aicp-bio-1-ts
```
Copy `aicp.yaml.example` → `aicp.yaml`.

Fill in your model parameters.
```bash
bun install
bun run src/main.ts
```

Visit http://127.0.0.1:9000

## Model Recommendations

AICP-BIO-1 requires a model with **strong coding ability**. The following two are recommended (tested in practice):

| Model | Provider | Notes |
|---|---|---|
| `doubao-code-2.0` | Volcano Engine / Aggregator | Strong coding, fast, cheap |
| `claude-sonnet-4.6` | Anthropic / Aggregator | Top-tier coding, stable reasoning |

⚠️ **Recommended model capability must be ≥ these two.**

Models below this capability level may fail in the following stages:

- **`generate_backend` / `generate_frontend`**: generated code may miss fields or imports
- **`contract_agent`**: contract extraction may be inaccurate
- **`main_agent`**: JSON output may be unstable, triggering retries
- **`aicp_chat`**: sandbox code generation may fail

**Go straight for a top-tier model.** The bottleneck of this system is not token cost — it is "getting it right the first time."
---

## End-to-End

From a one-line requirement to a running application, the entire path is handled by Agents:

```
User: build me a Pomodoro timer
  ↓
main_agent understands the requirement, confirms details
  ↓
generates spec (intermediate representation)
  ↓
generate_backend generates the backend Agent
  ↓
generate_frontend generates the frontend page
  ↓
hot reload, app goes live
  ↓
user visits /pomodoro/, it just works
```

There is no "human writes code" step. Requirements in, applications out.

## Recursive Self-Improvement (RSI)

AICP-BIO-1 is a Recursive Self-Improvement (RSI) system.

It is not "AI improving AI" — it is "AI improving the runtime that AI runs on."

Improvement happens at three levels:

| Level | Description |
|-------|-------------|
| **Task-level** | self-recursion — `main_agent` reads the flow each round, decides, writes back to the flow, and recurses. On failure, it retries until complete. |
| **Session-level** | experience accumulation — After a task completes, it distills experience, skills, and task boards. On similar tasks later, it reuses them. |
| **System-level** | Agent self-bootstrapping — `main_agent` can create, fix, and remove Agents. The system's capability boundary expands itself. |

The base model stays the same; the system's capability grows exponentially.

This is "engineering-grade RSI", more "controllable" than "intelligence-grade RSI".

## Architecture

```
┌──────────────────────────────────────┐
│  External State (flow / data / config)│
└──────────────────────────────────────┘
                ↕
┌──────────────────────────────────────┐
│  Agent (pure function)                │
│  execute(envelop, agent) → envelop   │
└──────────────────────────────────────┘
                ↕
┌──────────────────────────────────────┐
│  Envelop (message) + Agent (ability)  │
└──────────────────────────────────────┘
```

- **Envelop**: the message plane (sender / receiver / payload / meta)
- **Agent**: the ability plane (llm / config / system / data_dir / log)
- **Plugin**: the intersection of the two planes

## Everything is an Agent

An Agent is simply:

```
execute(envelop, agent) → envelop
```

No exceptions. Everything in the system is an Agent:

| What | Agent route |
|------|-------------|
| File I/O | `os/file_utils_api` |
| Main console | `builtins/agents/main_agent` |
| Contract extraction | `builtins/agents/contract_agent` |
| System map | `builtins/agents/cogitor` |
| Code generation | `builtins/studio/engine/generate_backend` |
| Create Agent | `builtins/tools/create_tool` |
| Fix Agent | `builtins/tools/fix_tool` |
| Remove Agent | `builtins/tools/remove_tool` |
| Subagent management | `builtins/tools/task_manager` |
| HTTP gateway | `os/_gateway` |
| WebSocket | `os/_websocket` |
| Cron | `os/_cron` |
| File receiver | `os/_file_receiver` |
| Static server | `os/_static` |
| Plugin registry | `os/_registry` |
| Frontend pages | `www/{project}` |

Even the HTTP server, WebSocket server, and cron scheduler are Agents.

## Self-Bootstrapping

AICP-BIO-1 can create, fix, and remove Agents:

```
main_agent calls create_tool
  ↓
create_tool calls generate_backend
  ↓
generate_backend produces a new Agent (same protocol)
  ↓
the new Agent is hot-reloaded
  ↓
main_agent calls the new Agent via the same Envelop
```

Closed loop.

## Call and Curl are the Same

- **Internal call** = construct an Envelop
- **External curl** = HTTP request, converted by the gateway into an Envelop

Both converge at the Envelop layer. Inside and outside are indistinguishable.

## Protocol

AICP-BIO-1 is driven by the AICP Protocol.

The protocol itself is just one thing:

```
execute(envelop, agent) → envelop
```

See [PROTOCOL.md](https://github.com/woozheng/aicp)for the full protocol.

## Other Implementations

- **Python**: [aicp-bio-1-python](https://github.com/woozheng/aicp-bio-1-python)

Both implementations follow the same protocol.

## Developer Preview

AICP-BIO-1 is in developer preview and iterating rapidly. There will be breaking changes.

## Citation

```bibtex
@misc{aicp-bio-1-ts-2026,
  title={AICP-BIO-1: Everything is an Agent (TypeScript)},
  author={dvwoo},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/woozhneg/aicp-bio-1-ts}},
}
```

## License

[MIT](./LICENSE)



