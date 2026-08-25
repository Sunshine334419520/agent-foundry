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
| 3 | **Agent 管理** | "模式 = 人设 + 工具权限" / 类型系统 / 配置 → [03-agent-management.md](03-agent-management.md)（理论篇，A 步完成） | `agent/agent.ts`、`agent/subagent-permissions.ts` | ✅ `agent/agent.ts`（Agent 类型 + 内置 build/plan，plan 用工具白名单"不许 edit"）；`loop/agent-loop.ts` 按 `session.agent` 解析 prompt + 工具白名单（finish 兜底）；`session/session.ts` 记录当前 agent；`cli/repl.ts` `/agent` 切换（权限矩阵细化留 #8） |
| 4 | **子代理** | spawn 机制 / 隔离 / 权限边界 / 并行 → [04-subagents.md](04-subagents.md)（理论篇，A 步完成） | `tool/task.ts`、`packages/core/src/background-job.ts`、`test/tool/task.test.ts` | ⬜（待 D：task 工具 + 子 Session 递归跑 loop） |
| 5 | **Tools** | 工具 schema / 注册 / 执行 / prompt 注入 → [05-tools.md](05-tools.md)（理论篇 A 步 + 具体工具精读 C 步 完成） | `tool/`（41 个工具 + `*.txt` 说明书）+ `session/tools.ts`（Def→AI SDK 桥接） | ✅ `tool/tool.ts`（ToolDef 数据：id/description/inputSchema/execute）+ `tool/registry.ts`（all / toolsFor(agent) / execute 统一包装：校验→执行→截断）+ `tool/truncate.ts`（字节截断）+ `tool/webfetch.ts` + `tool/websearch.ts`（**新增**，DDG 免费端点，搜索→抓取闭环）；agent-loop 改吃 registry。动态描述/按 model 过滤/插件钩子留后续 |
| 6 | **上下文管理** | compaction / token 预算 / overflow / 摘要 agent → [06-context-management.md](06-context-management.md)（理论篇，A 步完成） | `session/compaction.ts`、`summary.ts`、`overflow.ts`、`system.ts` + compaction agent + `packages/core/src/session/compaction.ts`（anchored summary） | ✅ `session/context.ts`（estimateTokens/usableTokens/isOverflow/serialize/buildSummaryPrompt/findKeepFrom）+ `session/compaction.ts`（compact：保留最近 2 轮 verbatim + compaction 隐藏 agent 压锚定摘要）+ `session.ts` 摘要折叠（toModelMessages 前置摘要块+跳过折叠段）+ `config.ts` modelLimit；agent-loop 每轮溢出检测。CLI `/compact` 手动压缩 + `/verbose` 学习日志（完整请求/AI 返回/摘要过程）。prune/auto-continue/overflow-replay 留后续 |
| 7 | **模型接入 / 流式** | provider 抽象 / 统一接口 / 流式事件 / prompt caching / 用量统计 → [07-streaming.md](07-streaming.md)（**流式已拉前深挖**，A-B-C-D 完成）+ [07b-provider-and-caching.md](07b-provider-and-caching.md)（**后半**：provider 抽象 / 统一接口 / caching / 用量，A 步完成，C 步精读完成，D 待做） | `provider/`、`session/llm/`（`ai-sdk.ts`、`native-runtime.ts`）、`packages/llm/`（`llm.ts`、`route/`、`protocols/`、`cache-policy.ts`）、`packages/llm/src/schema/events.ts` | ✅ 生产者 `llm/llm.ts stream()`（SSE→语义事件）+ `loop/agent-loop.ts` **纯生产者**（只 publish 不渲染）+ `bus/event-bus.ts` 总线（同比 opencode GlobalBus/EventV2）+ 消费者 `cli/render.ts` ReplRenderer（`cli/repl.ts` 组合根订阅）；`llm/stream.ts` 纯折叠供控制决策。隔离/多消费者/取消订阅已单测。**D 待做**：caching 断点注入（system 末块/tool 末个/最新 user）+ provider 接口抽象 + 用量数据化 |
| 8 | **权限** | 权限矩阵 / plan_enter / plan_exit / 用户确认 → [08-permissions.md](08-permissions.md)（理论篇，A 步完成，B 步用户确认理解） | `permission/evaluate.ts`、`permission/arity.ts`、`permission/index.ts`（Service/evaluate/fromConfig/disabled） | — D 跳过（用户决定：仅学理论） |
| 9 | **MCP** | 外部工具协议 / 生命周期 → [09-mcp.md](09-mcp.md)（理论篇，A 步完成；**纯理论，用户选择不读 opencode 代码**；待核对清单见附录） | `mcp/`（用户选择不读） | ⬜（若做：方案="stdio client + mock server 接进 ToolRegistry + 权限门"） |
| 10 | **Skill** | 技能加载 / 渐进披露 | `skill/` | ⬜ |
| 11 | **快照 / 撤销** | 状态回退 / 差异 / 审计 | `snapshot/`、`session/revert.ts` | ⬜ |
| 12 | **事件总线** | 事件驱动 / 模块解耦 | `bus/`（`global.ts`：GlobalBus）、`event-v2-bridge.ts`、`core/event.ts` | ◐ `bus/event-bus.ts`（简化版：Set 订阅集 + 异常隔离 + 取消订阅；**已随 #7 流式拉前**；将来可加持久化/历史事件流） |
| 13 | **持久化** | 数据库 / 会话恢复 / 审计 | `packages/core`、`effect-drizzle-sqlite`、`effect-sqlite-node` | ⬜ |
| 14 | **协议 / Server** | 通信协议 / 代码生成 / 守护进程 | `packages/protocol`、`packages/server` | ⬜ |

## B 梯队 · 前沿概念待学清单（源自 [docs/zhihu.md](../zhihu.md)）

> 2026-08-24 登记。这些概念不在 opencode 核心课程表（#1-#14）里，来自一线 Harness 框架的新特性。
> 学习方式同 A 梯队：每项做 **理论深挖（A）→ 源码精读（C）→ harness 落地（D）**，B 步视情况跳过。
> 标注的"权威参考"是候选切入点，深挖时再确认最新源码位置。
> **学习顺序**：下表从上到下；开工时把该项标记为进行中（◐），完成后打 ✅。

| # | 概念 | 一句话定义 | 权威参考（候选） | 状态 |
|---|---|---|---|---|
| B1 | **Memory 记忆系统** | 跨会话保存偏好/经验/失败教训，harness 自动写、启动时注入 | opencode 记忆系统 + Claude Code `~/.claude` 记忆；对照我们现有"单会话内"的 compact/clear | ⬜ |
| B2 | **Auto Dream** | 记忆整理巩固四阶段：Orient → Gather Signal → Consolidate → Prune（治记忆腐烂） | Claude Code /dream；对照第 6 课 compact（单会话）vs 跨会话巩固 | ⬜ |
| B3 | **OpenHuman 层次化记忆** | L0 chunk → L1 摘要 → L2 …，tombstone append-only，tree-walk 逐层下钻 + 多路检索 | OpenHuman 记忆系统（26k 行，取 tree-walk 思想）；对比普通 RAG | ⬜ |
| B4 | **Hook** | 固定生命周期点触发的确定性脚本，凌驾于模型之上（模型无法绕过） | Claude Code hooks（pre/post/stop）+ Humanize 的 Stop hook | ⬜ |
| B5 | **Goal / Plan** | 把完成条件变成持久状态，get/create/update_goal 三工具，对抗 Agentic Laziness | opencode/Claude Code 的 todo/plan；对照我们 finish 收尾信号 | ⬜ |
| B6 | **Plugin** | 把 Skill/Hook/SubAgent/MCP 打包分发 | DeepSeek Harness"一切皆插件"（Cordis 微内核） | ⬜ |
| B7 | **Agent Team** | 多实例自由通信 vs subagent 单线汇报 | 对照我们单 Main + 将来 SubAgent（#4） | ⬜ |
| B8 | **Dynamic Workflows** | 把编排写成 JS 脚本（agent/pipeline/parallel/phase/log/budget），中间结果搬出模型上下文 | **我们的 Workflow 工具即此理念的现成实现**，反读自己源码 | ⬜ |
| B9 | **Skill 治理（Curator）** | Skill active→stale→archived 三态，7 天合并 prefix 簇 | Hermes；呼应 #10 Skill 的容量约束 | ⬜ |

## 每个深挖单元怎么推进

见 [docs/LEARNING.md](../LEARNING.md) 的 **五步推进法**：

> **A 理论梳理**（我：读源码 + 查资料 → 理论文档）→ **B 理论学习**（你学 + 讨论）→ **C 代码精读**（带理论逐段读源码）→ **D 实现 harness** → **E 验收 + 笔记 ✅**

**关键纪律**：每步停下来讨论，确认懂了再进下一步，绝不自动往下冲。理论不扎实（B）绝不碰代码（C）。

## 学习顺序

按清单从上到下（#1 → #14）。开工时把该项的 harness 实现列标记为进行中，完成后打 ✅。

## 参考资料

- packages 目录总览（monorepo 地图）：[01-packages-overview.md](01-packages-overview.md)
