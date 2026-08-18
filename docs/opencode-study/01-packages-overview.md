# 01 · packages 目录总览 —— OpenCode 的 monorepo 地图

> 日期：2026-08-11
> 背景：从零手写最小 Agent（`demo/minimal-agent/`）之后，带着自己的心智模型读真实工程源码。
> 仓库：`anomalyco/opencode`（非 fork，默认分支 `dev`，TypeScript，约 432MB）

## 一句话总结

**OpenCode 就是把我们 demo 里的每个零件都放大成一个工程系统，再加上"一个 agent 多个界面"和"协议先行、代码生成"两个企业级设计。**

## 仓库元信息

| 项 | 值 |
|---|---|
| 仓库 | `anomalyco/opencode` |
| 默认分支 | `dev`（不是 main/master） |
| 语言 | TypeScript（monorepo，pnpm 管理） |
| 规模 | ~432MB，`packages/` 下 32 个包 |
| 核心源码 | `packages/opencode/src/` |
| 本地副本 | Windows：`D:\code\opencode`；macOS/Linux：`~/code/opencode`（稀疏克隆，只拉 `packages/`） |

## 骨架：一颗洋葱

```
你（终端 / 桌面 / Web / Slack）          ← ③ 界面层：同一个 agent，多种皮肤
        │
        ▼
   opencode  ── 主 Agent 包 ──  ★ session/（agent 循环）就在这里
        │
   ┌────┼────┬────┬────┐
  core  llm  tool permission    ← 核心领域、模型、工具、权限
        │
   schema / protocol             ← 全项目统一的数据结构 + 通信协议
        │
 数据库(effect-sqlite) · server · sdk ── ← 持久化、服务端、对外接口
```

## 六大层 × 32 个包

有 README 官方描述的是确证；其余按命名和源码 import 推断（标 ※）。

### ① 核心 Agent 层（与 demo 零件一一对应）

| 包 | 意义 |
|---|---|
| `opencode` | **主 Agent 包**。`session/`（循环）、`tool/`、`provider/`、`permission/`、`mcp/`、`skill/` 全在它 src 下 |
| `core` | 核心领域逻辑：Session/Project/Workspace 的领域模型（`@opencode-ai/core`） |
| `llm` | **模型层**。"Schema-first LLM core…one typed request, response, event, and tool language"——把各家模型统一成一套类型化接口。这是我们 demo 里"SDK 是翻译官"那一步的工程化放大版 |
| `codemode` | 沙箱化代码执行（"confined code execution over schema-described tools"） |

### ② 数据结构与协议层（Agent 内外的"语言"）

| 包 | 意义 |
|---|---|
| `schema` | 全项目统一的数据结构定义（消息、会话、part……） |
| `protocol` | 客户端↔服务器的通信协议 |
| `httpapi-codegen` | 从 schema **生成**类型化 HTTP API 代码（build-time codegen）※ |

### ③ 界面层（怎么跟 agent 说话）

| 包 | 意义 |
|---|---|
| `cli` | 命令行入口（yargs 命令注册） |
| `tui` | **终端 UI**（React 渲染，opencode 的招牌体验） |
| `ui` | 共享 UI 组件库 |
| `desktop` | Electron 桌面应用（"built with Electron"） |
| `app` | 应用主体（pnpm 模板） |
| `web` | 文档站（Starlight） |
| `console` | Web 管理台 |
| `session-ui` | 会话展示 UI |
| `slack` | Slack 机器人集成（"creates threaded conversations"） |
| `storybook` | UI 组件开发工具 |

### ④ 对外接口层（把 opencode 当库用）

| 包 | 意义 |
|---|---|
| `sdk` | 稳定版 SDK ※ |
| `sdk-next` | 新版 SDK："Effect-native scoped OpenCode host for **in-process** applications"——在进程内嵌一个 opencode |
| `client` | "@opencode-ai/client…derived directly from OpenCode's authoritative [schema]"——从权威 schema 生成的客户端 |

### ⑤ 服务端与基础设施层

| 包 | 意义 |
|---|---|
| `server` | `opencode serve` 的守护进程 ※ |
| `identity` | 用户身份/认证 ※ |
| `containers` | CI 预构建镜像（"baking in…"） |
| `enterprise` | 企业版（SolidStart 应用） |
| `stats` | 数据统计站（"Runtime, database, and domain services"） |
| `function` | serverless 函数 ※ |

### ⑥ 持久化 & 工具

| 包 | 意义 |
|---|---|
| `effect-drizzle-sqlite` / `effect-sqlite-node` | SQLite + Drizzle ORM 的 Effect 封装（session 持久化靠它） |
| `plugin` | 插件系统 |
| `http-recorder` | "Record real HTTP…replay from deterministic cassettes"——测试用录制回放 |
| `docs` | 文档（Mintlify） |
| `script` | 构建/脚本工具 ※ |

## OpenCode ↔ 我们的 demo 映射

| opencode 的部件 | 我们 demo 的零件 | 生产版多出来的东西 |
|---|---|---|
| `session/processor.ts` | `agent_loop` | 流式、重试、回退、todo、提醒 |
| `llm/` + `provider/` | `client.messages.create` + `CFG` | 统一 typed 接口、多 provider、用量统计 |
| `tool/` | `execute_tool` + `TOOLS` | 几十个工具 + **权限门控** + MCP |
| `session/compaction.ts` | `count_tokens` + `compress_context` | 真正的 compaction |
| `schema` / `protocol` | 我们的消息 dict 格式 | 全项目统一 schema + 代码生成 |
| `tui` / `cli` / `desktop` / `slack` | 我们的 `print()` | 各种"皮肤" |

## 学习地图（主线：harness 核心技术）

> 这 32 个包背后，是我们真正要学的 Agent harness 核心技术。**分阶段学习地图见 [LEARNING_MAP.md](LEARNING_MAP.md)**。

| harness 核心技术 | 主要在哪些包/目录 |
|---|---|
| Agent Loop | `opencode/src/session/processor.ts` |
| Session 管理 | `opencode/src/session/` |
| Agent 管理（模式/子代理） | `opencode/src/agent/` |
| Tools | `opencode/src/tool/`（41 个工具） |
| 上下文管理 | `opencode/src/session/compaction.ts`、`summary.ts` |
| 模型接入 | `opencode/src/provider/`、`llm/` |
| 权限 | `opencode/src/permission/` |
| 持久化 | `core/`、`effect-drizzle-sqlite`、`effect-sqlite-node` |
| 协议 / Server / SDK | `protocol/`、`server/`、`sdk`、`sdk-next` |
