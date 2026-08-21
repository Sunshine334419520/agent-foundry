# OpenCode 学习地图 —— Harness 核心知识

> **核心目标**：掌握下表每一项（**Harness 核心知识**），每项都做 **理论 + 源码** 双深挖，并在我们的 harness（`agent-foundry/harness/`）里实现。
> **配套源码**：Windows 下为 `D:\code\opencode`，macOS/Linux 下为 `~/code/opencode`（稀疏克隆，只拉了 `packages/`）。路径相对 `packages/opencode/src/`（除非另注明 `packages/`）。
> **阶段 0（地基，已完成）**：`handbook.md` → `deep-dive/part1-5` → 亲手写 Python 最小 Agent（`demo/minimal-agent/`）。

## 方法论基石：以代码为大纲，理论从代码中挖出

- 阶段 1 的理论只是"子集"，生产代码是"全集"——**不要用旧理论去框代码**，否则会漏掉代码里大量新理论。
- 正确做法：**通读源码 → 让代码告诉我们涉及哪些核心理论 → 逐个深入**（解决什么问题 / 怎么实现 / 有什么取舍）。
- 每个核心知识 = **理论深挖 + 源码精读 + harness 实现** 三件事，一件都不能少。

## Harness 核心知识清单（课程表）

| # | 核心知识 | 理论深挖（要挖透的） | opencode 源码 | harness 实现 |
|---|---|---|---|---|
| 1 | **Agent Loop** | 循环本质 / 停止条件 / 错误处理哲学 → [01-agent-loop.md](01-agent-loop.md)（理论篇，A 步完成） | `session/processor.ts`、`session/session.ts`、`prompt.ts`、`llm.ts`、`retry.ts` | ✅ **功能目录划分**（无 index 门面，具名文件+完整路径）：`loop/agent-loop.ts`(驱动器)·`session/session.ts`(数据)·`llm/llm.ts`(调用+用量)·`llm/retry.ts`(重试)·`config/config.ts`(定价) |
| 2 | **Session 管理** | 消息为何 schema 化 / 版本兼容(v2) / 状态机 / 为何持久化 → [02-session-management.md](02-session-management.md)（理论篇，A 步完成） | `session/`（`message*.ts`、`schema.ts`、`status.ts`、`run-state.ts`、`todo.ts`、`reminders.ts`）+ `packages/schema/src/v1/session.ts`、`packages/core/src/installation/version.ts` | ✅ `session/session.ts`：`StoredMessage/StoredPart`（id/parentID/version:1）+ `toModelMessages()` 存储→协议适配点（含中断工具兜底）；`loop/agent-loop.ts` 改吃适配产物，`cli/repl.ts` 零改动。Schema 校验/持久化仍留 #13 |
| 3 | **Agent 管理** | "模式 = 人设 + 工具权限" / 类型系统 / 配置 → [03-agent-management.md](03-agent-management.md)（理论篇，A 步完成） | `agent/agent.ts`、`agent/subagent-permissions.ts` | ⬜（待 D：把 SYSTEM_PROMPT 从 agent-loop 抽成 Agent 数据 + cli `/agent` 切换） |
| 4 | **子代理** | spawn 机制 / 隔离 / 权限边界 / 并行 | `tool/task.ts` | ⬜ |
| 5 | **Tools** | 工具 schema / 注册 / 执行 / prompt 注入 | `tool/`（41 个工具） | ◐ `src/tools.ts`（最小版） |
| 6 | **上下文管理** | compaction / token 预算 / overflow / 摘要 agent | `session/compaction.ts`、`summary.ts`、`overflow.ts`、`system.ts` + compaction agent | ⬜ |
| 7 | **模型接入 / 流式** | provider 抽象 / 统一接口 / 流式事件 / prompt caching / 用量统计 → [07-streaming.md](07-streaming.md)（**流式已拉前深挖**，A-B-C-D 完成；caching 等随 #6 补） | `provider/`、`session/llm/`（`ai-sdk.ts`、`native-runtime.ts`）、`packages/llm/src/schema/events.ts` | ✅ 生产者 `llm/llm.ts stream()`（SSE→语义事件）+ `loop/agent-loop.ts` **纯生产者**（只 publish 不渲染）+ `bus/event-bus.ts` 总线（同比 opencode GlobalBus/EventV2）+ 消费者 `cli/render.ts` ReplRenderer（`cli/repl.ts` 组合根订阅）；`llm/stream.ts` 纯折叠供控制决策。隔离/多消费者/取消订阅已单测 |
| 8 | **权限** | 权限矩阵 / plan_enter / plan_exit / 用户确认 | `permission/evaluate.ts`、`permission/arity.ts` | ⬜ |
| 9 | **MCP** | 外部工具协议 / 生命周期 | `mcp/` | ⬜ |
| 10 | **Skill** | 技能加载 / 渐进披露 | `skill/` | ⬜ |
| 11 | **快照 / 撤销** | 状态回退 / 差异 / 审计 | `snapshot/`、`session/revert.ts` | ⬜ |
| 12 | **事件总线** | 事件驱动 / 模块解耦 | `bus/`（`global.ts`：GlobalBus）、`event-v2-bridge.ts`、`core/event.ts` | ◐ `bus/event-bus.ts`（简化版：Set 订阅集 + 异常隔离 + 取消订阅；**已随 #7 流式拉前**；将来可加持久化/历史事件流） |
| 13 | **持久化** | 数据库 / 会话恢复 / 审计 | `packages/core`、`effect-drizzle-sqlite`、`effect-sqlite-node` | ⬜ |
| 14 | **协议 / Server** | 通信协议 / 代码生成 / 守护进程 | `packages/protocol`、`packages/server` | ⬜ |

## 每个深挖单元怎么推进

见 [docs/LEARNING.md](../LEARNING.md) 的 **五步推进法**：

> **A 理论梳理**（我：读源码 + 查资料 → 理论文档）→ **B 理论学习**（你学 + 讨论）→ **C 代码精读**（带理论逐段读源码）→ **D 实现 harness** → **E 验收 + 笔记 ✅**

**关键纪律**：每步停下来讨论，确认懂了再进下一步，绝不自动往下冲。理论不扎实（B）绝不碰代码（C）。

## 学习顺序

按清单从上到下（#1 → #14）。开工时把该项的 harness 实现列标记为进行中，完成后打 ✅。

## 参考资料

- packages 目录总览（monorepo 地图）：[01-packages-overview.md](01-packages-overview.md)
