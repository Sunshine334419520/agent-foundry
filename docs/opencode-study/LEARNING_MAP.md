# OpenCode 学习地图 —— Harness 核心知识

> **核心目标**：掌握下表每一项（**Harness 核心知识**），每项都做 **理论 + 源码** 双深挖，并在我们的 harness（`agent-foundry/harness/`）里实现。
> **配套源码**：`~/code/opencode`（稀疏克隆，只拉了 `packages/`）。路径相对 `packages/opencode/src/`（除非另注明 `packages/`）。
> **阶段 0（地基，已完成）**：`handbook.md` → `deep-dive/part1-5` → 亲手写 Python 最小 Agent（`demo/minimal-agent/`）。

## 方法论基石：以代码为大纲，理论从代码中挖出

- 阶段 1 的理论只是"子集"，生产代码是"全集"——**不要用旧理论去框代码**，否则会漏掉代码里大量新理论。
- 正确做法：**通读源码 → 让代码告诉我们涉及哪些核心理论 → 逐个深入**（解决什么问题 / 怎么实现 / 有什么取舍）。
- 每个核心知识 = **理论深挖 + 源码精读 + harness 实现** 三件事，一件都不能少。

## Harness 核心知识清单（课程表）

| # | 核心知识 | 理论深挖（要挖透的） | opencode 源码 | harness 实现 |
|---|---|---|---|---|
| 1 | **Agent Loop** | 循环本质 / 停止条件 / 错误处理哲学 | `session/processor.ts`、`session/session.ts` | ✅ `src/loop.ts` |
| 2 | **Session 管理** | 消息为何 schema 化 / 版本兼容(v2) / 状态机 / 为何持久化 | `session/`（`message*.ts`、`schema.ts`、`status.ts`、`run-state.ts`、`todo.ts`、`reminders.ts`） | ⬜ |
| 3 | **Agent 管理** | "模式 = 人设 + 工具权限" / 类型系统 / 配置 | `agent/agent.ts`、`agent/subagent-permissions.ts` | ⬜ |
| 4 | **子代理** | spawn 机制 / 隔离 / 权限边界 / 并行 | `tool/task.ts` | ⬜ |
| 5 | **Tools** | 工具 schema / 注册 / 执行 / prompt 注入 | `tool/`（41 个工具） | ◐ `src/tools.ts`（最小版） |
| 6 | **上下文管理** | compaction / token 预算 / overflow / 摘要 agent | `session/compaction.ts`、`summary.ts`、`overflow.ts`、`system.ts` + compaction agent | ⬜ |
| 7 | **模型接入 / 流式** | provider 抽象 / 统一接口 / 流式事件 / prompt caching / 用量统计 | `provider/`、`session/llm/`、`packages/llm` | ◐ `src/config.ts`（地基） |
| 8 | **权限** | 权限矩阵 / plan_enter / plan_exit / 用户确认 | `permission/evaluate.ts`、`permission/arity.ts` | ⬜ |
| 9 | **MCP** | 外部工具协议 / 生命周期 | `mcp/` | ⬜ |
| 10 | **Skill** | 技能加载 / 渐进披露 | `skill/` | ⬜ |
| 11 | **快照 / 撤销** | 状态回退 / 差异 / 审计 | `snapshot/`、`session/revert.ts` | ⬜ |
| 12 | **事件总线** | 事件驱动 / 模块解耦 | `bus/` | ⬜ |
| 13 | **持久化** | 数据库 / 会话恢复 / 审计 | `packages/core`、`effect-drizzle-sqlite`、`effect-sqlite-node` | ⬜ |
| 14 | **协议 / Server** | 通信协议 / 代码生成 / 守护进程 | `packages/protocol`、`packages/server` | ⬜ |

## 每个深挖单元的标准推进法

1. **通读入口源码** → 列出它涉及的核心理论（以代码为大纲，不用旧框架去框它）；
2. **逐个理论深入**：解决什么真实问题？代码怎么实现？有什么取舍？
3. **深理论落文档**：写一篇 `0X-<主题>.md`（记录"为什么"，不是抄代码）；
4. **在 harness 实现**该层，跑通验证。

## 学习顺序

按清单从上到下（#1 → #14）。开工时把该项的 harness 实现列标记为进行中，完成后打 ✅。

## 参考资料

- packages 目录总览（monorepo 地图）：[01-packages-overview.md](01-packages-overview.md)
