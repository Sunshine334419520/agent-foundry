# Agent Engineering Handbook

## 从 Agent 使用者到 Agent 构建者的完整进阶路线

---

> **适用人群**: 已能熟练使用 Claude Code / Cursor / Copilot 等 AI 工具完成项目开发，希望深入理解 Agent 底层机制，从"用 Agent 写代码的人"成长为"写 Agent 的人"。

---

## 目录

1. [前置自测：你现在在哪里](#1-前置自测你现在在哪里)
2. [五大核心机制的深度理解](#2-五大核心机制的深度理解)
3. [Agent Loop 工程实践](#3-agent-loop-工程实践)
4. [高级模式与架构](#4-高级模式与架构)
5. [生产级 Agent 系统](#5-生产级-agent-系统)
6. [实战项目路线图](#6-实战项目路线图)
7. [推荐阅读与资源](#7-推荐阅读与资源)

---

## 1. 前置自测：你现在在哪里

在开始之前，诚实回答以下问题。**不需要全会**，这是地图，不是考试。

### 初级 → 中级（你大概率已经过了）

- [ ] 能用自然语言让 AI 完成一个完整功能模块
- [ ] 理解 system prompt 和 user prompt 的区别
- [ ] 会写结构化的项目规则文件（CLAUDE.md / .cursorrules）
- [ ] 知道 tool use 是什么，见过 AI 调用工具
- [ ] 能通过对话引导 AI 做架构决策

### 中级 → 高级（你的目标）

- [ ] 能手写一个 agent loop（接收任务 → 调 LLM → 解析 tool call → 执行 → 循环）
- [ ] 理解 ReAct、Plan-and-Execute 的区别和适用场景
- [ ] 处理过 tool call 解析失败、token 超限、agent 循环等故障
- [ ] 设计过多 agent 协作系统
- [ ] 为 agent 系统实现了可观测性（tracing、logging）
- [ ] 理解 memory 的分层架构（短期/工作/长期记忆）
- [ ] 能根据任务特征选择合适的 planning 策略
- [ ] 处理过 prompt injection、tool call 安全等安全问题

### 专家级（长期目标）

- [ ] 从头实现过一个完整的 agent 框架
- [ ] 对 agent 系统的成本、延迟、可靠性做过系统性优化
- [ ] 在生产环境运行过 agent 系统并处理过边缘案例
- [ ] 发表过 agent 相关的研究或开源项目
- [ ] 能设计跨模型、跨供应商的通用 agent 架构

---

## 2. 五大核心机制的深度理解

### 2.1 Prompt Engineering

> 提示词不是"说话的艺术"，而是**信息架构**——如何在有限 token 预算内，向一个无状态的概率模型注入足够精确的上下文。

#### 2.1.1 信息流模型

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   System    │ → │    User     │ → │  Assistant  │ → │    Tool     │
│   Prompt    │   │   Message   │   │  Response   │   │   Result    │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
       ↓                  ↓                  ↓                  ↓
  角色定义           任务描述           推理+决策          执行反馈
  行为约束           上下文注入         工具调用           数据注入
  输出格式           示例引导           中间状态           下一步输入
```

**深层理解**：

- LLM 是**无状态的**。每次 API 调用都是一个全新的推理。对话的"连续性"完全靠你把历史消息拼接回去。
- **System prompt 影响全局行为分布**，user prompt 影响局部决策。两者的 token 预算需要策略性分配。
- Tool result 是**最容易被低估的信息源**。它重新进入上下文的方式决定了 agent 的"学习"质量。

#### 2.1.2 Token 预算策略

```
总上下文窗口（例如 200K）
├── System Prompt      10-20%  角色、规则、输出格式
├── 长期记忆           5-10%   持久化的关键信息
├── 对话历史           30-50%  最近的交互轮次
├── Tool Results       20-30%  工具返回的数据
├── 工作记忆           5-10%   当前任务的临时状态
└── 预留空间            5-10%  防止截断
```

**实践要点**：

1. **分层注入**：核心规则（system prompt）→ 任务上下文（user prompt）→ 动态数据（tool result）。不要在每一层重复信息。
2. **动态摘要**：当对话历史过长时，不是简单地 truncate 前面的消息，而是用 LLM 生成结构化摘要（关键决策、当前状态、未完成任务）。
3. **选择性遗忘**：某些 tool result 在消费后就应该从上下文中移除，而不是永久保留。

#### 2.1.3 Prompt 模板设计模式

| 模式 | 适用场景 | 示例 |
|------|---------|------|
| **Zero-shot** | 简单、通用任务 | "翻译以下文本" |
| **Few-shot** | 需要特定格式或风格 | 给 2-3 个输入-输出示例 |
| **Chain-of-Thought** | 需要多步推理 | "让我们一步一步思考" |
| **Role-based** | 需要专业视角 | "你是一个安全审计专家" |
| **Constrained** | 需要精确输出格式 | "只返回 JSON，不要解释" |
| **Adversarial** | 验证/挑战任务 | "请找出以下方案的所有缺陷" |

#### 2.1.4 你的练习

```
练习 1：Token 预算分析
拿一个你现有的 CLAUDE.md 或 system prompt
→ 统计每一部分的 token 数（用 tiktoken 或 API）
→ 标注哪些是高价值信息，哪些可以压缩
→ 重写一版，目标：保持效果的同时减少 30% token

练习 2：Prompt 变体对比
对同一个任务写 3 种 prompt 策略（zero-shot / few-shot / CoT）
→ 让同一个模型各跑 10 次
→ 记录输出质量、一致性、token 消耗
→ 写一份对比分析报告
```

---

### 2.2 Skill 设计

> Skill 是 **Agent 的可组合行为原语**。它不是简单的"预设 prompt"，而是一个完整的指令-执行-反馈闭环的封装。

#### 2.2.1 Skill 的本质

```
一个完整的 Skill = {
  trigger:      "什么情况下激活"（关键词、意图匹配、上下文信号）
  context:      "激活时注入什么信息"（领域知识、约束、示例）
  behavior:     "执行什么流程"（单步 / 多步 / 含 tool use / 含确认）
  output:       "产出什么结果"（文本 / 结构化数据 / 副作用）
  fallback:     "失败时怎么办"（重试 / 降级 / 转人工）
}
```

#### 2.2.2 Skill 的层级

| Level | 名称 | 特征 | 例子 |
|-------|------|------|------|
| L1 | Template Skill | 纯 prompt 模板，无逻辑 | "用中文回复" |
| L2 | Guided Skill | prompt + 步骤清单 | "代码审查：先检查类型，再检查安全" |
| L3 | Tooled Skill | 含 tool use 的完整流程 | "部署：检查环境 → 构建 → 发布 → 验证" |
| L4 | Orchestrator Skill | 调度多个子 Skill | "全栈功能开发：前端 Skill → 后端 Skill → 联调" |

#### 2.2.3 Skill 协作模式

```
模式 1：顺序管道
Skill A → Skill B → Skill C
适用：流程固定的任务

模式 2：条件路由
        ┌→ Skill A (如果是 bug)
意图识别 ─┼→ Skill B (如果是 feature)
        └→ Skill C (如果是 question)

模式 3：并行执行
Skill A ─┐
Skill B ─┼→ 合并结果
Skill C ─┘
适用：多维度分析、独立子任务

模式 4：循环迭代
Skill → 检查结果 → 不满足 → 调整参数 → Skill → ...
适用：需要多轮优化的任务
```

#### 2.2.4 Skill 设计原则

1. **单一职责**：一个 Skill 只做一件事。不要写"全栈开发 Skill"。
2. **显式边界**：明确 Skill 的输入、输出、前置条件和副作用。
3. **可组合**：Skill 的输出格式应该能被其他 Skill 消费。
4. **可降级**：Skill 失败时应该有明确的 fallback 行为。
5. **可测试**：能用一组标准输入验证 Skill 的行为。

#### 2.2.5 你的练习

```
练习 3：Skill 审计
检查你现有的所有 Skill
→ 每个 Skill 属于 L1-L4 的哪一级？
→ 哪些 Skill 之间有协作关系？
→ 是否缺少关键的 fallback 逻辑？
→ 重写一个你最不满意的 Skill

练习 4：Skill 系统设计
设计一套 5-7 个 Skill 来管理一个完整的软件开发流程
（需求分析 → 架构设计 → 编码 → 测试 → 部署）
→ 定义每个 Skill 的接口（输入/输出格式）
→ 定义 Skill 之间的协作模式
→ 画出完整的协作流程图
```

---

### 2.3 Memory 架构

> Memory 不是"存东西"，而是**在正确的时间向 Agent 提供正确的信息**。

#### 2.3.1 三层记忆模型

```
┌────────────────────────────────────────────────────┐
│                    工作记忆 (Working)               │
│     当前任务的状态、中间结果、pending actions       │
│     生命周期：单次任务                             │
│     容量：极有限（靠 LLM 上下文承载）               │
├────────────────────────────────────────────────────┤
│                  短期记忆 (Short-term)              │
│     对话历史、最近的 tool results、用户偏好          │
│     生命周期：单次会话                             │
│     策略：滑动窗口 + 动态摘要                       │
├────────────────────────────────────────────────────┤
│                  长期记忆 (Long-term)               │
│     用户画像、项目知识、历史决策、领域知识            │
│     生命周期：跨会话持久化                          │
│     策略：向量检索 + 结构化查询 + 元数据过滤        │
└────────────────────────────────────────────────────┘
```

#### 2.3.2 长期记忆的实现策略

| 策略 | 原理 | 优点 | 缺点 |
|------|------|------|------|
| **全文检索 (BM25)** | 关键词匹配 | 精确、快速 | 无语义理解 |
| **向量检索 (Embedding)** | 语义相似度 | 理解意图 | 可能召回不精确结果 |
| **混合检索** | BM25 + 向量组合 | 取长补短 | 实现复杂 |
| **知识图谱** | 实体+关系结构化存储 | 精确推理 | 构建成本高 |
| **摘要压缩** | 用 LLM 定期压缩记忆 | 信息密度高 | 细节丢失 |

#### 2.3.3 记忆更新策略

```
记忆的生命周期：
创建 → 检索 → 强化（再次用到则提权）→ 衰减（长期不用降权）→ 遗忘

关键决策点：
1. 什么触发记忆写入？（每次交互？手动？关键决策后？）
2. 如何避免记忆污染？（错误信息写入后的修正机制）
3. 如何检索？（什么时候检索？检索多少条？如何排序？）
4. 如何给检索结果分配上下文窗口空间？
```

#### 2.3.4 高级话题

- **程序性记忆**：不只是"记住了什么"，而是"记住了怎么做"——将成功的操作序列作为 pattern 存储。
- **情景记忆**：记录完整的事件上下文（当时的状态→决策→结果），用于未来类似场景的参考。
- **记忆一致性**：当多个 agent 共享记忆时，如何保证信息一致性。

#### 2.3.5 你的练习

```
练习 5：实现一个记忆系统
用 SQLite + numpy（或只用文件系统）实现一个三层记忆系统：
→ Working memory：Python dict，存当前任务状态
→ Short-term：list，带时间戳的消息历史
→ Long-term：vector store（可以用 sentence-transformers）
→ 实现：写入、检索、衰减、遗忘四个操作
→ 测试：模拟 50 轮对话后，系统能否正确检索到第 5 轮提到的事实

练习 6：记忆压缩实验
拿一段 100 轮的对话历史
→ 用滑动窗口（只保留最近 20 轮）
→ 用 LLM 生成结构化摘要
→ 用混合策略（最近 10 轮 + 摘要 + 关键事实列表）
→ 对比三种策略在下游任务中的表现
```

---

### 2.4 Planning 策略

> Planning 是 agent 智能的核心体现——不是"做什么"，而是**用什么策略来组织"做什么、何时做、如何验证"**。

#### 2.4.1 主流策略对比

##### ReAct（Reason + Act）—— 最基础的模式

```
循环：
  Thought: 我需要做什么？
  Action:  调用哪个工具，传什么参数？
  Observation: 工具返回了什么？
  → 如果任务完成：输出最终答案
  → 如果没完成：回到 Thought

适用：大多数通用任务
局限：容易在复杂/长链条任务中迷失方向
```

##### Plan-and-Execute —— 先规划再执行

```
阶段 1 - Planning：
  分析任务 → 生成步骤清单 → 用户确认（可选）

阶段 2 - Execution：
  对每个步骤 → ReAct 循环 → 记录结果 → 进入下一步

阶段 3 - Verification：
  检查所有步骤是否完成 → 验证结果 → 报告

适用：多步骤、有明确里程碑的任务
局限：plan 可能一开始就错了，中途调整能力弱
```

##### Tree-of-Thought (ToT) / Graph-of-Thought (GoT)

```
            ┌→ 方案 A → 评估（好）→ 继续
            │
问题分析 ──┼→ 方案 B → 评估（差）→ 放弃
            │
            └→ 方案 C → 评估（中）→ 分支探索

每一步生成多个候选，评估后剪枝，保留最优路径继续
适用：需要创造性或探索性的任务
局限：token 消耗大，延迟高
```

##### Reflexion —— 自我反思与修正

```
执行 → 自我评估 → 发现不足 → 分析原因 → 调整策略 → 重新执行

核心理念：agent 不仅执行，还对自己的执行结果做元认知
适用：需要高质量输出的任务
局限：多轮迭代成本高
```

#### 2.4.2 策略选择决策树

```
任务复杂度？
├── 单步可完成 → 直接执行（不需要 planning）
├── 2-5 步，路径明确 → ReAct
├── 5+ 步，有里程碑 → Plan-and-Execute
├── 方案不明确，需要探索 → Tree-of-Thought
└── 质量要求极高，允许迭代 → Reflexion + ReAct
```

#### 2.4.3 实践中的混合模式

真实的生产级 agent 很少只用一种策略：

```
高层：Plan-and-Execute（制定和跟踪里程碑）
  └── 中层：ReAct（执行每个步骤）
       └── 低层：Reflexion（对关键子步骤做自我修正）
            └── 特殊情况：Tree-of-Thought（遇到难题时并行探索）
```

#### 2.4.4 你的练习

```
练习 7：实现三种 Planning 策略
对同一个任务（例如"为一个 Web 应用添加用户认证功能"）：
→ 用纯 ReAct 实现
→ 用 Plan-and-Execute 实现
→ 用 Plan-and-Execute + Reflexion 实现
→ 对比三种方案的：token 消耗、执行时间、输出质量
→ 写一份对比分析报告

练习 8：Planning 失败分析
故意给 agent 一个不合理的任务（例如"用 CSS 实现一个数据库"）
→ 观察不同 planning 策略如何失败
→ ReAct 会陷入无限循环吗？
→ Plan-and-Execute 的 plan 一开始就错了吗？
→ 设计对应的"提前终止"和"意图修正"机制
```

---

### 2.5 Tool Use 设计

> Tool 是 Agent 与外部世界交互的唯一通道。Tool 的设计质量直接决定了 Agent 的能力上限。

#### 2.5.1 Tool 的定义与生命周期

```json
{
  "name": "search_files",
  "description": "Search for files matching a pattern. Use this to find files by name, not content.",
  "parameters": {
    "type": "object",
    "properties": {
      "pattern": {
        "type": "string",
        "description": "Glob pattern like '**/*.ts' or 'src/**/*.tsx'"
      },
      "path": {
        "type": "string",
        "description": "Directory to search in. Defaults to project root."
      }
    },
    "required": ["pattern"]
  }
}
```

**Tool 调用的完整生命周期**：

```
1. LLM 生成 tool call（name + arguments JSON）
2. Agent loop 解析 JSON → 验证参数类型 → 检查权限
3. 执行 tool（可能涉及副作用）
4. 将结果格式化后注入回对话上下文
5. LLM 看到结果，决定下一步动作
```

**每个环节都可能出错**：

| 环节 | 常见错误 | 处理策略 |
|------|---------|---------|
| JSON 解析 | 格式错误、字段缺失 | 重试请求（带错误提示）|
| 参数验证 | 类型不匹配、超出范围 | 返回明确错误信息给 LLM |
| 权限检查 | 越权调用 | 拒绝 + 告知 LLM 权限边界 |
| 执行 | 超时、异常、副作用 | 超时机制 + 错误信息格式化 |
| 结果注入 | 结果过大超出上下文 | 截断 + 标注 + 提供分页/详细查询 |

#### 2.5.2 Tool 设计原则

**1. 粒度原则**

```
太粗：一个 Tool 做太多事
  ❌ edit_project(project_id, changes: {files, deps, config, ...})
  LLM 难以精确控制，错误时难以定位

太细：每个小操作一个 Tool
  ❌ open_file(), read_char(), write_char(), close_file()
  调用次数爆炸，上下文膨胀

合适：一个 Tool 完成一个语义完整的操作
  ✅ read_file(path, offset?, limit?)
  ✅ write_file(path, content)
  ✅ edit_file(path, old_string, new_string)
```

**2. 描述清晰度原则**

Tool 的 description 是 LLM 决定是否调用它的唯一依据：

```json
// ❌ 差
{ "name": "update", "description": "Update something" }

// ❌ 仍然差（没有说什么时候用、什么时候不用）
{ "name": "update_config", "description": "Update the configuration" }

// ✅ 好
{
  "name": "update_config",
  "description": "Update a key-value pair in the project configuration file. Use this for persistent settings changes. Do NOT use for temporary/env-var changes — those don't need config updates."
}
```

**3. 错误返回格式原则**

Tool 返回的错误应该是**对 LLM 有用**的，不是对人类开发者的：

```
// ❌ 差（对 LLM 无帮助）
"Error: ENOENT"

// ❌ 仍然差（LLM 不知道该怎么办）
"File not found"

// ✅ 好（LLM 知道下一步该做什么）
"Error: File '/path/to/file.ts' not found.
→ Did you mean '/path/to/file.tsx'? (similar name exists)
→ Use list_files('/path/to') to see available files."
```

**4. 幂等性**

可读操作天然幂等，但写操作需要设计：

```python
# ✅ 幂等的写操作
write_file(path, content)    # 始终覆盖为指定内容
delete_file(path)            # 文件不存在也不报错

# ⚠️ 非幂等的写操作
append_file(path, content)   # 每次调用都追加
execute_command(cmd)         # 可能产生累积副作用
```

#### 2.5.3 Tool 组合模式

```
模式 1：查询-操作（最基础）
  search(query) → 获取 ID → get_detail(id) → update(id, data)

模式 2：并行独立调用
  read_file(a) ─┐
  read_file(b) ─┼→ 同时执行，减少往返
  read_file(c) ─┘

模式 3：条件链
  try_operation() → 成功 → done
                  → 失败 → fallback_operation() → done

模式 4：批量操作
  batch_process(items[]) → 返回每个 item 的结果 + 错误列表
```

#### 2.5.4 你的练习

```
练习 9：Tool 设计评审
拿你项目中现有的 tool/IPC 接口
→ 按粒度原则评审：哪些太粗？哪些太细？
→ 给每个 tool 的 description 打分（LLM 能否准确判断何时调用？）
→ 检查错误返回格式：是否对 LLM 有指导性？
→ 重写一组 tool definitions

练习 10：Tool 故障模拟
在 agent loop 中故意制造 tool 故障：
→ Tool 返回格式错误的 JSON
→ Tool 超时（30s 没响应）
→ Tool 返回的数据太大（100K tokens）
→ Tool 返回权限错误
→ 为每种故障实现恢复/降级策略
→ 记录 LLM 对各种故障的反应
```

---

## 3. Agent Loop 工程实践

> 这是从"使用者"到"构建者"最关键的一步：**亲手写一个 agent loop**。

### 3.1 最小可行 Agent Loop

用不超过 200 行代码实现。语言任选（Python/TypeScript 均可）。

```python
"""
minimal_agent.py — 最小 Agent Loop 实现
依赖：pip install anthropic
运行：python minimal_agent.py "你的任务"
"""

import anthropic
import json
import sys
from typing import Any

# ============================================================
# 第 1 步：定义你的 Tool
# ============================================================
TOOLS = [
    {
        "name": "read_file",
        "description": "Read the contents of a file. Use to examine existing code.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path to the file"}
            },
            "required": ["path"]
        }
    },
    {
        "name": "write_file",
        "description": "Write or overwrite a file with new content. Use to create or update files.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path to the file"},
                "content": {"type": "string", "description": "Content to write"}
            },
            "required": ["path", "content"]
        }
    },
    {
        "name": "run_command",
        "description": "Run a shell command and return its output.",
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "The command to execute"}
            },
            "required": ["command"]
        }
    },
    {
        "name": "finish",
        "description": "Call this when the task is complete. Provide a summary.",
        "input_schema": {
            "type": "object",
            "properties": {
                "summary": {"type": "string", "description": "What was accomplished"}
            },
            "required": ["summary"]
        }
    }
]

SYSTEM_PROMPT = """You are an AI coding assistant. You have access to tools.
Work step by step. When the task is done, call the finish tool.
Be precise and careful with file operations."""

# ============================================================
# 第 2 步：实现 Tool 执行器
# ============================================================
import subprocess
import os

def execute_tool(name: str, args: dict) -> str:
    """执行 tool 并返回格式化的结果字符串"""
    try:
        if name == "read_file":
            if not os.path.exists(args["path"]):
                return f"Error: File '{args['path']}' not found."
            with open(args["path"], "r") as f:
                content = f.read()
            # 防止结果过大撑爆上下文
            if len(content) > 10000:
                content = content[:10000] + "\n... [truncated, use offset/limit to read more]"
            return content

        elif name == "write_file":
            os.makedirs(os.path.dirname(args["path"]) or ".", exist_ok=True)
            with open(args["path"], "w") as f:
                f.write(args["content"])
            return f"Successfully wrote {len(args['content'])} bytes to {args['path']}"

        elif name == "run_command":
            result = subprocess.run(
                args["command"], shell=True, capture_output=True, text=True, timeout=30
            )
            output = result.stdout
            if result.stderr:
                output += "\n[stderr]\n" + result.stderr
            if len(output) > 5000:
                output = output[:5000] + "\n... [truncated]"
            return output

        elif name == "finish":
            return "Task marked as complete."

        else:
            return f"Error: Unknown tool '{name}'"

    except Exception as e:
        return f"Error executing {name}: {str(e)}\nPlease try a different approach."

# ============================================================
# 第 3 步：核心 Agent Loop
# ============================================================
def agent_loop(task: str, max_steps: int = 25) -> str:
    client = anthropic.Anthropic()  # 使用 ANTHROPIC_API_KEY 环境变量

    messages = [{"role": "user", "content": task}]

    for step in range(max_steps):
        print(f"\n{'='*60}")
        print(f"Step {step + 1}/{max_steps}")

        # 3a. 调用 LLM
        response = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=4096,
            system=SYSTEM_PROMPT,
            messages=messages,
            tools=TOOLS,
        )

        # 3b. 提取 assistant 消息
        assistant_msg = {"role": "assistant", "content": response.content}
        messages.append(assistant_msg)

        # 3c. 检查是否有 tool call
        tool_calls = [b for b in response.content if b.type == "tool_use"]

        if not tool_calls:
            # 没有 tool call → LLM 认为任务完成
            text_blocks = [b for b in response.content if b.type == "text"]
            final_text = "\n".join(b.text for b in text_blocks)
            print(f"\nAgent finished:\n{final_text}")
            return final_text

        # 3d. 执行所有 tool calls
        print(f"Tool calls: {[tc.name for tc in tool_calls]}")
        tool_results = []

        for tc in tool_calls:
            print(f"  → {tc.name}({json.dumps(tc.input, ensure_ascii=False)[:100]})")
            result = execute_tool(tc.name, tc.input)
            print(f"  ← {result[:200]}...")
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": tc.id,
                "content": result,
            })

        # 3e. 将结果注入上下文
        messages.append({"role": "user", "content": tool_results})

    return "Agent reached max steps without finishing."

# ============================================================
# 第 4 步：运行
# ============================================================
if __name__ == "__main__":
    task = sys.argv[1] if len(sys.argv) > 1 else "Create a file called hello.txt with 'Hello World' in it"
    print(f"Task: {task}")
    result = agent_loop(task)
    print(f"\n{'='*60}")
    print(f"Final result: {result}")
```

### 3.2 从这个最小实现开始，逐步添加

#### 第一轮迭代：健壮性

```python
# 添加到 agent_loop 的开头

# 1. Token 计数与预算管理
import tiktoken

enc = tiktoken.get_encoding("cl100k_base")

def count_tokens(messages):
    total = len(enc.encode(SYSTEM_PROMPT))
    for msg in messages:
        for block in (msg["content"] if isinstance(msg["content"], list) else [msg]):
            if isinstance(block, dict):
                total += len(enc.encode(json.dumps(block)))
            else:
                total += len(enc.encode(str(block)))
    return total

# 在每次循环开始前检查
if count_tokens(messages) > 150_000:  # 假设 200K 窗口
    # 执行上下文压缩
    messages = compress_context(messages)

# 2. Tool call 重试
MAX_TOOL_RETRIES = 2
for attempt in range(MAX_TOOL_RETRIES + 1):
    try:
        # 正常的 tool call 流程
        break
    except json.JSONDecodeError:
        if attempt < MAX_TOOL_RETRIES:
            messages.append({
                "role": "user",
                "content": [{"type": "text", "text": "Your last tool call had invalid JSON. Please fix and retry."}]
            })
        else:
            raise

# 3. 循环检测
recent_actions = []  # 记录最近 N 步的 tool call 序列
CYCLE_THRESHOLD = 3  # 同一个 action 连续 3 次 → 判定循环

def is_stuck(recent_actions):
    if len(recent_actions) < CYCLE_THRESHOLD * 2:
        return False
    pattern = recent_actions[-CYCLE_THRESHOLD:]
    return recent_actions.count(pattern) >= 2
```

#### 第二轮迭代：高级控制

```python
# 4. 子任务分解（lightweight planning）
def decompose_task(task: str) -> list[str]:
    """用 LLM 把大任务拆成子任务"""
    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1024,
        system="Break the task into ordered subtasks. Return a JSON array of strings.",
        messages=[{"role": "user", "content": task}]
    )
    return json.loads(response.content[0].text)

# 5. 自我检查（Reflexion）
def self_check(result: str, original_task: str) -> tuple[bool, str]:
    """让 LLM 检查自己的输出是否满足要求"""
    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=512,
        system="You are a quality checker. Review if the result satisfies the task. Return JSON: {\"satisfied\": bool, \"issues\": string}",
        messages=[{
            "role": "user",
            "content": f"Task: {original_task}\n\nResult:\n{result}\n\nDoes the result satisfy the task?"
        }]
    )
    check = json.loads(response.content[0].text)
    return check["satisfied"], check["issues"]

# 6. 人机交互插入点
def needs_human_approval(action: dict) -> bool:
    """判断某个操作是否需要人类确认"""
    DANGEROUS_ACTIONS = {
        "run_command": ["rm -rf", "git push --force", "DROP TABLE"],
        "write_file": [],  # 根据文件重要性判断
    }
    # 检查逻辑...
    return False

# 7. 结构化日志
import time
import uuid

run_id = str(uuid.uuid4())[:8]

def log_step(step_num, event_type, details):
    """结构化日志，便于事后分析和调试"""
    log_entry = {
        "run_id": run_id,
        "timestamp": time.time(),
        "step": step_num,
        "event": event_type,
        "details": details,
    }
    print(f"[{run_id}] Step {step_num} | {event_type} | {json.dumps(details, ensure_ascii=False)[:200]}")
    # 也可以写入文件
```

### 3.3 你的核心练习

```
练习 11：实现完整 Agent Loop
目标：从上面的 minimal_agent.py 开始，逐步添加所有功能
最终产物：一个功能完整的 agent loop，包含：
  ✅ 基础循环（observe → think → act）
  ✅ Token 预算管理
  ✅ Tool call 重试
  ✅ 循环检测与打断
  ✅ 任务分解
  ✅ 自我检查（Reflexion）
  ✅ 结构化日志
  ✅ 人机交互确认

测试任务：
  1. "在当前目录创建一个简单的待办事项 Web 应用"
  2. "阅读 src/ 下所有 TypeScript 文件并写出架构总结"
  3. "运行测试，如果有失败的，分析原因并修复"
```

---

## 4. 高级模式与架构

### 4.1 多 Agent 协作

#### 4.1.1 协作拓扑

```
拓扑 1：主从模式 (Master-Worker)
        ┌─────────────┐
        │   Master    │ ← 分解任务，分配，汇总
        └──────┬──────┘
      ┌────────┼────────┐
      ▼        ▼        ▼
  Worker1  Worker2  Worker3  ← 各负责一个子任务

适用：任务可以清晰分解成独立子任务
示例：代码审查（一个看安全，一个看性能，一个看风格）

拓扑 2：辩论模式 (Debate)
  Agent A ──→ 观点 1 ──┐
                        ├──→ Judge Agent → 最终判断
  Agent B ──→ 观点 2 ──┘

适用：需要多个视角的决策
示例：架构方案选择

拓扑 3：流水线模式 (Pipeline)
  Agent A → 产物 → Agent B → 产物 → Agent C → 最终输出

适用：任务有明确的阶段依赖
示例：需求分析 → 设计文档 → 代码实现

拓扑 4：分层模式 (Hierarchical)
         Strategy Agent
        ┌───────┼───────┐
  Planning A  Planning B  Planning C
     │            │            │
  Execution  Execution  Execution

适用：复杂的长周期任务
示例：大型项目开发
```

#### 4.1.2 Agent 间通信协议

```python
# 标准化的 Agent 间消息格式
{
    "from": "security-reviewer",
    "to": "orchestrator",
    "type": "finding",           # finding | question | handoff | complete
    "priority": "high",          # low | medium | high | critical
    "content": {
        "summary": "SQL injection in login handler",
        "detail": "...",
        "suggestion": "...",
    },
    "context": {                 # 传递必要的上下文
        "file": "src/auth/login.ts",
        "line": 42,
    }
}
```

#### 4.1.3 任务分配策略

| 策略 | 原理 | 适用 |
|------|------|------|
| **基于能力** | 根据 agent 的专业领域分配 | 异构 agent 群 |
| **基于负载** | 发给当前空闲的 agent | 同构 agent 群 |
| **基于上下文** | 发给已经持有相关上下文的 agent | 减少上下文切换 |
| **竞标模式** | agent 自荐 + coordinator 选择 | 能力重叠的 agent 群 |

### 4.2 Agent 状态机设计

一个健壮的 agent 不只是"while True 调 LLM"，而是一个**显式状态机**：

```
                    ┌──────────┐
                    │   IDLE   │
                    └────┬─────┘
                         │ 收到任务
                    ┌────▼─────┐
               ┌───│ PLANNING │
               │   └────┬─────┘
               │        │ plan ready
               │   ┌────▼─────┐
               │   │ EXECUTING│◄────────┐
               │   └────┬─────┘         │
               │        │ tool result   │
               │        ├───────────────┘
               │        │ max steps / stuck
               │   ┌────▼─────┐
               │   │ REFLECTING│──→ 需要修正策略 → PLANNING
               │   └────┬─────┘
               │        │ 任务完成
               │   ┌────▼─────┐
               │   │VERIFYING │──→ 未通过 → EXECUTING
               │   └────┬─────┘
               │        │ 验证通过
               │   ┌────▼─────┐
               └──►│   DONE   │
                   └──────────┘
```

```python
from enum import Enum, auto
from dataclasses import dataclass

class AgentState(Enum):
    IDLE = auto()
    PLANNING = auto()
    EXECUTING = auto()
    REFLECTING = auto()
    VERIFYING = auto()
    WAITING_HUMAN = auto()
    DONE = auto()
    ERROR = auto()

@dataclass
class AgentContext:
    state: AgentState
    task: str
    plan: list[str]
    current_step: int
    messages: list
    retries: int
    checkpoint: dict  # 快照，用于恢复

class StatefulAgent:
    def __init__(self):
        self.ctx = AgentContext(
            state=AgentState.IDLE,
            task="",
            plan=[],
            current_step=0,
            messages=[],
            retries=0,
            checkpoint={},
        )

    def run(self, task: str):
        self.ctx.task = task
        self.ctx.state = AgentState.PLANNING

        while self.ctx.state not in (AgentState.DONE, AgentState.ERROR):
            if self.ctx.state == AgentState.PLANNING:
                self._do_planning()
            elif self.ctx.state == AgentState.EXECUTING:
                self._do_execute()
            elif self.ctx.state == AgentState.REFLECTING:
                self._do_reflect()
            elif self.ctx.state == AgentState.VERIFYING:
                self._do_verify()
            elif self.ctx.state == AgentState.WAITING_HUMAN:
                self._wait_human()

    def _do_planning(self): ...
    def _do_execute(self): ...
    def _do_reflect(self): ...
    def _do_verify(self): ...
    def _wait_human(self): ...
```

### 4.3 Agent 的 Checkpoint 与恢复

生产环境中的 agent 可能运行数小时。崩溃不可接受。

```python
import pickle
import hashlib

class AgentCheckpoint:
    """Agent 状态的持久化快照"""
    
    def save(self, ctx: AgentContext):
        """在每个状态转换时保存快照"""
        state_hash = self._hash_context(ctx)
        checkpoint = {
            "state": ctx.state.name,
            "task": ctx.task,
            "plan": ctx.plan,
            "current_step": ctx.current_step,
            "retries": ctx.retries,
            "hash": state_hash,
        }
        with open(f".agent_checkpoints/{state_hash}.json", "w") as f:
            json.dump(checkpoint, f)

    def restore(self) -> AgentContext | None:
        """从最近的快照恢复"""
        # 找到最近的 checkpoint 文件
        # 恢复到对应的状态
        ...

    def _hash_context(self, ctx: AgentContext) -> str:
        """生成上下文的确定性哈希"""
        ...
```

### 4.4 Streaming 与实时交互

```python
async def agent_loop_streaming(task: str):
    """流式 agent loop — 用户可以实时看到 LLM 的思考过程"""
    
    async with client.messages.stream(
        model="claude-sonnet-4-20250514",
        max_tokens=4096,
        system=SYSTEM_PROMPT,
        messages=messages,
        tools=TOOLS,
    ) as stream:
        # 实时输出文本
        async for text in stream.text_stream:
            print(text, end="", flush=True)
            yield {"type": "text_delta", "content": text}

        # 获取最终的完整响应
        final = await stream.get_final_message()

        # 处理 tool calls
        for block in final.content:
            if block.type == "tool_use":
                yield {"type": "tool_call", "name": block.name, "args": block.input}
```

---

## 5. 生产级 Agent 系统

### 5.1 可观测性

一个没有可观测性的 agent 系统就是黑盒——出了问题你根本不知道是哪一步错了。

#### 5.1.1 三层可观测性

```
L1 — 日志（Logging）：每一步的状态变化
    {step: 3, state: "executing", tool: "read_file", args: {...}, 
     result_len: 523, duration_ms: 142}

L2 — 追踪（Tracing）：一次完整任务的全链路
    trace_id: abc123
    ├── planning (2.3s)
    ├── step1: search_files (0.5s)
    ├── step2: read_file (0.1s)
    ├── step3: edit_file (0.3s)
    └── step4: finish (1.2s)
    Total: 4.4s, tokens: 8421, cost: $0.18

L3 — 指标（Metrics）：聚合统计
    avg_steps_per_task: 7.2
    tool_call_success_rate: 0.94
    p50_latency: 3.2s
    p99_latency: 45s
    cost_per_task_avg: $0.23
```

#### 5.1.2 实现示例

```python
import time
from contextlib import contextmanager

class AgentTracer:
    def __init__(self):
        self.spans = []
        self.current_trace = None

    def start_trace(self, task: str) -> str:
        trace_id = str(uuid.uuid4())[:8]
        self.current_trace = {
            "trace_id": trace_id,
            "task": task,
            "start_time": time.time(),
            "spans": [],
            "metrics": {"total_tokens": 0, "total_cost": 0.0},
        }
        return trace_id

    @contextmanager
    def span(self, name: str, metadata: dict = None):
        """记录一个操作片段"""
        span = {"name": name, "start": time.time(), "metadata": metadata or {}}
        try:
            yield span
        except Exception as e:
            span["error"] = str(e)
            raise
        finally:
            span["end"] = time.time()
            span["duration_ms"] = (span["end"] - span["start"]) * 1000
            self.current_trace["spans"].append(span)

    def end_trace(self) -> dict:
        self.current_trace["end_time"] = time.time()
        self.current_trace["duration_s"] = (
            self.current_trace["end_time"] - self.current_trace["start_time"]
        )
        return self.current_trace

# 使用
tracer = AgentTracer()
trace_id = tracer.start_trace("Create a TODO app")

with tracer.span("planning"):
    plan = decompose_task(task)

for i, step in enumerate(plan):
    with tracer.span(f"execute_step_{i}", {"subtask": step}):
        run_step(step)

report = tracer.end_trace()
print(f"Trace {trace_id}: {report['duration_s']:.1f}s, {len(report['spans'])} spans")
```

### 5.2 成本控制

| 策略 | 说明 | 节省幅度 |
|------|------|---------|
| **模型分级** | 简单任务用小模型，复杂任务用大模型 | 40-60% |
| **Prompt 缓存** | 缓存 system prompt 和长工具定义 | 50-90%（命中时）|
| **上下文压缩** | 在 token 接近限制前主动压缩历史 | 20-40% |
| **提前终止** | 检测循环/无进展时终止 | 防止无限消耗 |
| **批量工具调用** | 合并不依赖的 tool call 到一次 API 调用 | 减少往返 |

```python
# 模型路由策略
def select_model(task_complexity: str, estimated_steps: int) -> str:
    if task_complexity == "simple" and estimated_steps <= 3:
        return "claude-haiku-4-5-20251001"      # 最便宜
    elif task_complexity == "medium":
        return "claude-sonnet-4-20250514"        # 性价比
    else:
        return "claude-sonnet-4-20250514"        # 或者 opus

# 带缓存的 LLM 调用
def cached_llm_call(messages, system, tools, cache_key):
    """如果 system + tools 组合被缓存过，使用 prompt caching"""
    return client.messages.create(
        model=MODEL,
        system=[
            {"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}
        ],
        messages=messages,
        tools=[
            {**tool, "cache_control": {"type": "ephemeral"}} 
            for tool in tools
        ],
    )
```

### 5.3 安全性

#### 5.3.1 Prompt Injection 防御

```python
# 输入清洗：所有用户输入和外部数据都要经过清洗
def sanitize_input(text: str) -> str:
    """移除可能的 prompt injection 模式"""
    # 1. 移除常见的 injection 标记
    dangerous_patterns = [
        r"<\|im_start\|>",       # 特殊 token
        r"<\|im_end\|>",
        r"\[SYSTEM\]",           # 伪装的系统指令
        r"\[INST\]",
        r"ignore previous",
        r"disregard above",
    ]
    for pattern in dangerous_patterns:
        text = re.sub(pattern, "[FILTERED]", text, flags=re.IGNORECASE)
    return text

# 输出验证：LLM 的输出在使用前要验证
def validate_tool_call(tool_name: str, args: dict) -> bool:
    """验证 tool call 是否安全"""
    # 1. 白名单检查
    ALLOWED_TOOLS = {"read_file", "write_file", "search", "run_command"}
    if tool_name not in ALLOWED_TOOLS:
        return False

    # 2. 参数边界检查
    if tool_name == "run_command":
        BLOCKED_COMMANDS = ["rm -rf /", "format", "shutdown", "curl.*|.*sh"]
        for blocked in BLOCKED_COMMANDS:
            if re.search(blocked, args.get("command", "")):
                return False

    # 3. 路径遍历检查
    if tool_name in ("read_file", "write_file"):
        path = os.path.normpath(args.get("path", ""))
        if path.startswith("..") or os.path.isabs(path):
            return False

    return True
```

#### 5.3.2 沙箱化

```
Agent 的安全边界：
┌─────────────────────────────────────────────┐
│                  Host System                 │
│  ┌───────────────────────────────────────┐  │
│  │           Agent Runtime               │  │
│  │  ┌─────────────────────────────────┐  │  │
│  │  │       Sandbox (Docker/VM)       │  │  │
│  │  │  ┌───────────────────────────┐  │  │  │
│  │  │  │   Tool Execution          │  │  │  │
│  │  │  │   (limited permissions)   │  │  │  │
│  │  │  └───────────────────────────┘  │  │  │
│  │  └─────────────────────────────────┘  │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

### 5.4 测试 Agent 系统

测试 agent 很难，因为输出是非确定性的。关键是**不测试具体输出，测试不变量**。

```python
import pytest

class TestAgentLoop:
    def test_completes_within_max_steps(self):
        """Agent 不应该无限循环"""
        result = agent_loop("Create a hello.txt file", max_steps=10)
        # 不检查具体输出，只检查是否完成
        assert result is not None

    def test_creates_file_when_asked(self):
        """Agent 应该能完成基本的文件创建任务"""
        agent_loop("Create /tmp/test_agent_hello.txt with 'hello'")
        assert os.path.exists("/tmp/test_agent_hello.txt")
        with open("/tmp/test_agent_hello.txt") as f:
            assert "hello" in f.read()
        os.remove("/tmp/test_agent_hello.txt")

    def test_handles_missing_file_gracefully(self):
        """读取不存在的文件时不应崩溃"""
        result = agent_loop("Read the file /tmp/nonexistent_xyz.txt")
        # 应该正常完成（报告文件不存在），而不是崩溃
        assert result is not None

    def test_tool_call_retry_on_json_error(self):
        """模拟 JSON 解析错误时应该重试"""
        # 需要 mock 一个会返回错误 JSON 的 tool
        ...

    def test_cost_stays_within_budget(self):
        """验证 token 消耗在预算内"""
        tracer = AgentTracer()
        tracer.start_trace("Simple task")
        agent_loop("List files in current directory")
        report = tracer.end_trace()
        assert report["metrics"]["total_tokens"] < 10000

    def test_loop_detection(self):
        """检测到循环时应该终止"""
        # 设计一个会让 agent 陷入循环的任务
        ...
```

---

## 6. 实战项目路线图

按顺序完成以下项目。每个项目都比前一个更难。

### 项目 1：CLI Agent（1-2 周）

**描述**：实现一个命令行 agent，可以操作文件系统。
**技术栈**：Python + Anthropic SDK
**关键功能**：
- 基础 agent loop
- 5-10 个 file system tools
- Token 管理
- 基本错误处理

**验收标准**：
- [ ] 能通过自然语言完成"在当前目录创建项目结构"
- [ ] 能读取多个文件并回答关于代码的问题
- [ ] 不会在简单的文件操作上无限循环

### 项目 2：Code Review Agent（1 周）

**描述**：一个专门做代码审查的 agent。
**关键功能**：
- 多维度审查（安全、性能、风格各一个 agent）
- 结果汇总 agent
- 输出结构化的审查报告

**验收标准**：
- [ ] 审查 3 个真实 PR 并与人工审查结果对比
- [ ] 误报率 < 40%
- [ ] 漏报率 < 30%

### 项目 3：Research Agent（2 周）

**描述**：能自主搜索 web、阅读文档、写研究报告的 agent。
**关键功能**：
- Web search + web fetch tools
- 长文档阅读与摘要
- 多源信息交叉验证
- 引用管理

**验收标准**：
- [ ] 就一个技术话题写出 2000 字研究报告
- [ ] 报告中至少 5 个来源引用
- [ ] 信息来源可验证

### 项目 4：Multi-Agent DevOps Agent（3 周）

**描述**：管理一个完整部署流程的多 agent 系统。
**关键功能**：
- 部署 agent：构建 → 测试 → 部署
- 监控 agent：检查服务健康状态
- 告警 agent：发现问题后诊断并修复
- Orchestrator：协调所有 agent

**验收标准**：
- [ ] 能从 git push 自动化部署到服务器
- [ ] 能在服务异常时自动诊断并尝试修复
- [ ] 有完整的日志和追踪

### 项目 5：Agent 框架（4 周+）

**描述**：从头实现一个通用的 agent 开发框架。
**关键功能**：
- 可插拔的 LLM provider（至少支持 2 家）
- 可配置的 planning 策略
- 可扩展的 tool 系统
- 完善的 memory 架构
- 完整的可观测性
- 多 agent 协调

**验收标准**：
- [ ] 别人能用你的框架在 1 小时内搭建一个基本 agent
- [ ] 框架通过了项目 1-4 的测试用例
- [ ] 有完善的文档

---

## 7. 推荐阅读与资源

### 必读论文

| 论文 | 核心内容 | 为什么重要 |
|------|---------|-----------|
| [ReAct](https://arxiv.org/abs/2210.03629) | Reasoning + Acting 范式 | Agent loop 的理论基础 |
| [Plan-and-Solve](https://arxiv.org/abs/2305.04091) | 先规划再执行 | 理解 planning 的必要性 |
| [Reflexion](https://arxiv.org/abs/2303.11366) | 自我反思机制 | Agent 自我改进的核心 |
| [Tree of Thoughts](https://arxiv.org/abs/2305.10601) | 树状搜索推理 | 探索性任务的最佳实践 |
| [AutoGen](https://arxiv.org/abs/2308.08155) | 多 agent 对话框架 | 理解 agent 间通信 |
| [MemGPT](https://arxiv.org/abs/2310.08560) | 虚拟内存管理 | Memory 架构的经典实现 |
| [Toolformer](https://arxiv.org/abs/2302.04761) | LLM 自学使用工具 | Tool use 的训练视角 |

### 实践资源

| 资源 | 类型 | 链接 |
|------|------|------|
| Anthropic Cookbook | 代码示例 | github.com/anthropics/anthropic-cookbook |
| LangGraph 源码 | 框架学习 | github.com/langchain-ai/langgraph |
| CrewAI 源码 | 多 agent 框架 | github.com/crewAIInc/crewAI |
| Building Effective Agents | 博客 | anthropic.com/engineering/building-effective-agents |
| OpenAI Agents SDK | 框架参考 | github.com/openai/openai-agents-python |

### 推荐的学习路径

```
月 1-2：基础
  ├── 通读 Anthropic Cookbook 中所有 agent 相关示例
  ├── 完成项目 1（CLI Agent）
  └── 读完 ReAct 和 Plan-and-Solve 论文

月 3-4：进阶
  ├── 完成项目 2（Code Review Agent）+ 项目 3（Research Agent）
  ├── 研究 LangGraph 源码（重点看 agent loop 和 state management）
  └── 读 Reflexion、Tree of Thoughts、MemGPT

月 5-6：高级
  ├── 完成项目 4（DevOps Agent）
  ├── 研究 CrewAI 或 AutoGen 源码
  └── 开始项目 5（自己的 Agent 框架）

月 7+：专家
  ├── 完成项目 5
  ├── 在生产环境运行你的 agent 系统
  └── 持续优化成本、延迟、可靠性
```

---

## 附录：自检清单

每完成一个阶段后，回到 1.1 的自测列表，重新打勾。你的目标是在 6 个月内让"中级→高级"全部打勾，"专家级"至少打勾一半。

---

> **最后的话**
> 
> Agent Engineering 不是一个"学完"的东西。它是一个不断深化的实践领域。你的 FlashNote 项目已经证明了你作为 builder 的能力。现在要做的，是把同样的工程思维应用到 agent 系统本身——**不是用 agent 建东西，而是建 agent 本身**。
> 
> 这个转变的核心就一件事：**亲手写代码实现 agent loop**。一旦你写了第一个 200 行的 agent loop，你对所有 AI 编程工具的理解都会发生质变。你会开始"看到" Claude Code 内部在做什么，而不是把它当作魔法。
> 
> 祝你好运。🚀
