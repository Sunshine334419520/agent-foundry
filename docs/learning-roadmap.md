# AI 应用开发工程师 — 学习 Roadmap

> **适用人群**：已掌握 Agent Engineering 理论（见 [handbook.md](handbook.md)）、能手写最小 Agent Loop（见 [demo/minimal-agent/](../demo/minimal-agent/)），目标是成长为高级 AI 应用开发工程师。
>
> **总周期**：6-9 个月。基于本人现状定制：理论 ✅、最小 agent ✅、使用 DeepSeek（Anthropic 兼容端点）、build-to-learn 学习风格。

---

## 目录

1. [学习原则](#1-学习原则)
2. [Phase 0：巩固与测量底座](#2-phase-0巩固与测量底座2-3-周)
3. [Phase 1：opencode 选择性研究 + 核心重实现](#3-phase-1opencode-选择性研究--核心重实现4-6-周)
4. [Phase 2：RAG 工程落地](#4-phase-2rag-工程落地2-3-周)
5. [Phase 3：生产化工程](#5-phase-3生产化工程3-4-周)
6. [Phase 4：多 Agent 与安全攻防](#6-phase-4多-agent-与安全攻防3-4-周)
7. [Phase 5：框架素养与系统设计深度](#7-phase-5框架素养与系统设计深度4-周持续)
8. [Phase 6：收官项目——完整产品](#8-phase-6收官项目完整产品4-6-周)
9. [每周固定节奏](#9-每周固定节奏)
10. [求职者补充](#10-求职者补充)
11. [自检清单](#11-自检清单)

---

## 1. 学习原则

贯穿 6-9 个月的三个铁律：

1. **一切改动都被评估**：没有 eval 数据的"我感觉变好了"不算数。
2. **读源码带着问题读**：不是"读 opencode"，是"读 opencode 为了重实现 X"。
3. **文档化**：每阶段产出一篇 `docs/deep-dive/` 文档。

---

## 2. Phase 0：巩固与测量底座（2-3 周）

**目标**：把最小 agent 升级为完整版，并**先建好 eval 系统**——后面所有阶段都靠它衡量。

| 学什么 | 做什么 |
|--------|--------|
| LLM 底层：采样/token 化/上下文窗口/function calling | 用 LLM 结构化摘要替换 `compress_context` 的朴素截断 |
| Prompt caching 原理与成本 | 给 demo 加 `cache_control`，对比启用前后 token 成本 |
| Streaming | 给 loop 加流式输出 |
| **Eval 方法论**（golden tasks / LLM-as-judge / 回归） | 建 20-30 个 golden task + eval harness |

**产出**：`demo/full-agent/` + `demo/eval-harness/`
**验收**：能对 30 个任务输出 成功率/平均步数/token 报告；改一次 prompt 能说出"值不值"

---

## 3. Phase 1：opencode 选择性研究 + 核心重实现（4-6 周）⭐

**目标**：用 opencode V2 的思路，把 demo 升级成"mini-opencode"。

> opencode 正处于 V1→V2 迁移期（legacy 服务模式 → Effect 函数式架构），源码新旧混杂。**优先读 V2 部分**：`packages/core`（agent 系统）、`packages/server`、`packages/protocol`、`packages/client`，以及 `packages/opencode/specs/effect/`（描述目标架构的 spec 文档）。`bridge.ts` 和 legacy 域是正在被删除的代码，跳过。

| 读 opencode 什么 | 在自己的 demo 重实现什么 |
|-----------------|------------------------|
| `packages/core` agent 系统（build/plan 模式） | **Plan 模式**（先规划后执行，规划阶段禁写） |
| session 管理与 compaction | **Session 持久化 + checkpoint 恢复 + 压缩** |
| tool 系统（registry、默认拒绝权限） | **Tool registry + allow/deny 权限模型** |
| provider 抽象 | **Provider 抽象层**（DeepSeek/OpenAI/本地一套接口） |
| MCP 集成 | **MCP 客户端** |
| prompt 构造（~54KB 组装逻辑） | 自己的 context 组装模块 |

**关键纪律**：每个功能实现完 → 跑 eval → 记录提升/回退。
**产出**：`demo/opencode-clone/` + 一篇《opencode V2 架构拆解》文档
**验收**：选定 5 个核心功能与 opencode 行为对齐，且每个都有 eval 数据支撑

---

## 4. Phase 2：RAG 工程落地（2-3 周）

**目标**：把 Memory 理论变成能检索、能评估的真实 RAG 系统。

- Chunking 策略、Embedding 选型、向量库（Chroma/Qdrant/轻量自建）
- 混合检索（BM25 + 向量）、Rerank、索引增量更新
- **RAG 专属 eval**：检索命中率（Recall@k）+ 回答质量

**产出**：`demo/rag-agent/` + eval 套件
**验收**：能回答"chunk 大小 500→800 检索命中率变化多少"

---

## 5. Phase 3：生产化工程（3-4 周）

**目标**：把同步脚本变成能部署的服务。

- 异步 + Streaming（SSE/WebSocket）+ 任务队列 + 状态持久化
- 崩溃恢复（对应 opencode V2 的 SQLite 落盘思路）
- 可观测性：结构化日志 + Trace（OTel 思路）+ 指标聚合
- 成本控制：模型路由、缓存、预算强制

**产出**：`demo/production-agent/`（FastAPI 风格服务）+ trace 全链路
**验收**：一个跑了 10 分钟的任务中途崩溃能恢复继续；每个任务有成本报告

---

## 6. Phase 4：多 Agent 与安全攻防（3-4 周）

**目标**：协作架构 + 补上手册里最弱的"正则屏蔽安全"。

- Master-Worker 多 agent（代码审查三件套：安全/性能/风格 + judge）
- **Prompt injection red-team**：先攻击自己的 agent，再加固（数据/指令隔离、最小权限、沙箱、工具白名单），再重测

**产出**：`demo/multi-agent/` + `demo/red-team/`
**验收**：加固后攻击成功率可量化下降

---

## 7. Phase 5：框架素养与系统设计深度（4+ 周，持续）

**目标**：从"会写 loop"到"知道什么时候该用/不该用框架"。

- 读 LangGraph 源码（重点：state 管理），对照自己的实现
- 框架横向对比：CrewAI / AutoGen / OpenAI Agents / Claude Agent SDK，写进 `case-studies/`
- 系统设计：写《设计一个 1000 QPS 的 agent 服务》设计文档
- 补经典论文：ReAct、Reflexion、ToT、MemGPT、Toolformer

**产出**：2-3 篇 `case-studies/` + 1 份系统设计文档
**验收**：能对一个任务给出"用框架 or 自研"的论证和理由

---

## 8. Phase 6：收官项目——完整产品（4-6 周）

**目标**：把所有能力集成成一个端到端产品，作为作品集核心。

建议选题：**带 Streaming UI 的 Research Agent**（RAG + 多 agent + 可观测 + eval + 成本报告）。

**产出**：开源项目 + 完整文档 + eval 报告 + 《我是怎么构建它的》总结
**验收**：别人能按 README 部署；你能拿它讲清楚每一个架构决策

---

## 9. 每周固定节奏

| 动作 | 频率 |
|------|------|
| 读 1 篇论文/工程博客，写 200 字总结进 repo | 每周 |
| 读 opencode/LangGraph 源码，写进 `case-studies/` | 每周 3-5 小时 |
| 跑一次 eval，记录结果 | 每周 |
| 写/改一篇文档 | 每周 |

---

## 10. 求职者补充

如果目标是找工作，重点调整：

- **面试官最常追问的"生产级"话题**：Phase 1（session/压缩/权限）、Phase 3（异步/可观测/成本）——优先级最高
- **系统设计题**：Phase 5 的"1000 QPS agent 服务"就是面试原题形状
- **国内加分项**：国产模型生态（DeepSeek/Qwen）、企业级 RAG、AI 应用后端工程——Phase 2 和 Phase 3 覆盖
- **作品集**：Phase 6 的收官项目 + 每阶段的 eval 报告，就是"高级工程师"最硬的证据

---

## 11. 自检清单

每完成一个阶段，回来打勾：

### Phase 0
- [ ] 用 LLM 结构化摘要替换了朴素截断
- [ ] 给 demo 加上了 prompt caching 并对比过成本
- [ ] agent 支持流式输出
- [ ] 能对 30 个 golden tasks 输出 成功率/步数/token 报告
- [ ] 改一次 prompt 后能说出"值不值"（有数据支撑）

### Phase 1
- [ ] 实现了 Plan 模式（规划阶段禁写）
- [ ] 实现了 session 持久化 + checkpoint 恢复 + 压缩
- [ ] 实现了 tool registry + 默认拒绝的权限模型
- [ ] 实现了 provider 抽象层（≥2 家供应商）
- [ ] 实现了 MCP 客户端
- [ ] 每个功能都有 eval 数据支撑
- [ ] 完成《opencode V2 架构拆解》文档

### Phase 2
- [ ] 能回答"chunk 大小改变后检索命中率变化多少"
- [ ] 实现混合检索 + rerank
- [ ] RAG agent 有独立的检索与回答质量 eval

### Phase 3
- [ ] 同步 loop 变成了异步服务
- [ ] 崩溃后能恢复继续
- [ ] 有完整的日志/trace/指标
- [ ] 每个任务有成本报告

### Phase 4
- [ ] 实现了一个多 agent 协作系统
- [ ] 完成了 prompt injection red-team 攻击与加固
- [ ] 加固后攻击成功率有量化下降

### Phase 5
- [ ] 能给出"用框架 or 自研"的论证
- [ ] 完成了《1000 QPS agent 服务》设计文档
- [ ] 读完了经典论文清单

### Phase 6
- [ ] 完整产品可部署、有文档、有 eval 报告
- [ ] 能讲清楚每一个架构决策

---

> **最后的话**
>
> 这份 roadmap 的核心不是"学完多少东西"，而是**建立一个衡量系统**。高级工程师和中级工程师的分水岭，不是谁懂得多，而是**谁能用数据证明自己的改动有效**。Eval 就是这个衡量系统本身。
