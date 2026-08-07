# Agent Engineering 深度实践 · Part 1

## Prompt 与消息流：从使用者到构建者的认知跃迁

---

> 这是 FlashNote 项目借助 Claude Code 开发过程中，对 Agent 核心机制的深度学习和实践记录。Part 1 聚焦 Prompt Engineering 和消息流机制。

---

## 0. 前置认知

### 0.1 最核心的一个事实

> **LLM 是金鱼脑。每次 API 调用都是完全独立的推理。对话的"连续性"完全靠你把全部历史消息重新传回去。**

这不是比喻——这是物理事实。Anthropic 的服务器上没有任何"会话状态"。你说的"对话"，本质上是 Agent Loop 在每次调用时把历史上所有消息一字不差地拼接回去。

### 0.2 四个角色的本质

| 角色 | 谁产生的 | 在 Agent Loop 中的位置 | 类比 |
|------|---------|----------------------|------|
| **System Prompt** | Agent Loop 配置 | 每次 API 调用的 `system` 参数 | 签合同时写的"工作规范"——全程生效 |
| **User Message** | 用户 或 Agent Loop（作为工具结果） | `messages[].role = "user"` | 你每次发的任务，以及工具执行后的反馈 |
| **Assistant Response** | LLM | `messages[].role = "assistant"` | LLM 的思考结果和工具调用意图 |
| **Tool Result** | Agent Loop（执行工具后） | `messages[].role = "user"`, content 里是 tool_result block | 外部世界的状态，被注入回对话 |

---

## 1. System Prompt 到底是什么

### 1.1 本质

System Prompt 是**每次 API 调用都会携带的一组上层指令**。它不被视为"对话"的一部分，而是"对话的舞台"——它设定了 LLM 的角色、行为边界、可用工具。

### 1.2 在 Claude Code 中的构成

当你启动 Claude Code 时，实际的 System Prompt 是多个来源拼接而成的：

```
┌──────────────────────────────────────────┐
│  Claude Code 内置 System Prompt          │  ← 你改不了
│  "你是一个交互式 CLI agent，帮助用户..."    │
├──────────────────────────────────────────┤
│  工具定义（从代码注册的 tools）             │  ← 代码决定
│  Read / Write / Edit / Bash / Glob ...   │
├──────────────────────────────────────────┤
│  CLAUDE.md 内容                          │  ← 你写的，可提交到 git
│  "FlashNote — Electron + React..."       │
├──────────────────────────────────────────┤
│  Memory 系统注入的内容（按需）              │  ← 语义匹配，个人专属
│  "Switch to MSI installer because..."    │
├──────────────────────────────────────────┤
│  会话元信息                               │  ← 自动生成
│  git status, 当前分支, 平台信息...         │
└──────────────────────────────────────────┘
                    ↓
           拼成一段超长文本
                    ↓
           作为 system 参数传给 API
```

### 1.3 关键认知

- **System Prompt 影响全局行为分布**——它决定了 LLM 在所有对话中展现的"人格"和能力边界
- **User Message 影响局部决策**——它决定了 LLM 在当前这一步做什么
- **System Prompt 每次调用都重复发送**——这就是为什么精简它如此重要

---

## 2. Assistant 与 Tool 的真实关系

### 2.1 核心纠错

最常见的误解是"Assistant 调用 Tool"。**这是错的。**

```
❌ 错误理解：
   Assistant → 调用 → Tool → 返回结果给 Assistant

✅ 正确理解：
   LLM 输出 Assistant 消息（包含 tool_use 意图）
        ↓
   Agent Loop（你的代码）解析 tool_use
        ↓
   Agent Loop 自己执行工具
        ↓
   Agent Loop 把结果封装为 User 消息
        ↓
   Agent Loop 把 User 消息塞回 messages 数组
        ↓
   再次调用 LLM
```

**LLM 从头到尾只是一个"说话的大脑"。手脚是 Agent Loop。Tool 是外部世界。Agent Loop 是大脑和外界的翻译官。**

### 2.2 完整一轮：用你的 FlashNote 项目演示

当你对 Claude Code 说"帮我在 CardWall 加类型筛选"：

```
═══════════════ API 调用 1 ═══════════════
system:  Claude Code 内置 + CLAUDE.md + Memory
messages:
  [0] user:      "帮我在 CardWall 加类型筛选"

Claude 返回 assistant 消息:
  [1] assistant: "我来看看现有代码" + tool_use: Read("CardWall.tsx")

═══════════════ API 调用 2 ═══════════════
system:  (同上，又发了一遍)
messages:
  [0] user:      "帮我在 CardWall 加类型筛选"
  [1] assistant: "我来看看..." + tool_use: Read(...)

→ Agent Loop 检测到 tool_use
→ Agent Loop 执行 Read 工具，读到文件内容
→ Agent Loop 把结果封装成 user 消息

  [2] user:      tool_result: "import { type ReactElement } from 'react'..."

Claude 返回 assistant 消息:
  [3] assistant: "我看到了，还需要读 types.ts" + tool_use: Read("types.ts")

═══════════════ API 调用 3 ═══════════════
system:  (同上，又发了一遍)
messages:
  [0] user:      "帮我在 CardWall 加类型筛选"
  [1] assistant: "我来看看..." + tool_use: Read(...)
  [2] user:      tool_result: CardWall.tsx 内容
  [3] assistant: "还需要读..." + tool_use: Read("types.ts")

→ Agent Loop 执行 Read → 注入

  [4] user:      tool_result: types.ts 内容

Claude 返回 assistant 消息:
  [5] assistant: "明白了，现在修改" + tool_use: Edit("CardWall.tsx", ...)

═══════════════ API 调用 4 ═══════════════
... 继续 ...
```

### 2.3 为什么 Tool Result 的 role 是 "user"

这是 Anthropic API 的设计细节：

```json
// Tool Result 的角色是 "user"，不是 "tool"
{"role": "user", "content": [{"type": "tool_result", "tool_use_id": "abc", "content": "..."}]}
```

**原因**：Anthropic 认为 tool result 在语义上等同于"用户去执行了某个操作，然后把结果告诉 LLM"。它和"用户说了一句话"没有本质区别——都是来自 LLM 外部的信息注入。

### 2.4 金鱼脑的实验证明

如果你在 Agent Loop 里恶意删掉前面的消息，只保留最后一条 tool result：

```python
# 恶意修改
messages = [{"role": "user", "content": [tool_result]}]  # 只有工具结果

response = client.messages.create(messages=messages, ...)
```

LLM 会回复：**"？？？你给我看一段代码是什么意思？你要我干嘛？"**

它真的不知道前面的对话——因为它根本没收到。

---

## 3. LLM 没有"记忆"——那对话怎么连续的

### 3.1 真相

当你说"第 11 次工具调用后，LLM 还记得前 10 次的结果吗？"

**答案是：LLM 内部没有任何缓存。它之所以"记得"，是因为你把 20 条消息（10 轮）又传了一遍。**

```
第 11 次 API 调用发送的内容：

{
  "system": "你是 Claude...（CLAUDE.md）...",    ← 又发了一遍
  "messages": [
    {"role":"user",      "content":"帮我加功能"},           // 第 1 条
    {"role":"assistant", "content":"好的..." + tool_use},    // 第 2 条
    {"role":"user",      "content":"文件内容: import..."},   // 第 3 条
    ...中间 14 条...
    {"role":"assistant", "content":"写入成功"},              // 第 19 条
    {"role":"user",      "content":"修改完成"},              // 第 20 条
  ],
  "tools": [{...}, {...}]                       ← 又发了一遍
}
```

### 3.2 Prompt Caching 不是记忆

| | Prompt Caching | 真正的记忆 |
|---|---|---|
| 做什么 | 服务器缓存计算结果，跳过重复推理 | 存储信息，需要时检索 |
| LLM 知道吗 | 不知道——它"看到"的内容完全一样 | 会——它有新的信息 |
| 效果 | 省钱、加速 | 给 LLM 提供新的事实 |
| 类比 | 背课文时跳过已经会背的段落 | 笔记本上记了新东西 |

**Prompt Caching 是 CDN 缓存，不是大脑记忆。**

### 3.3 这解释了长对话的三个问题

| 现象 | 根因 |
|------|------|
| 对话 30 轮后 Claude 变笨 | messages 超出上下文窗口，前 10 轮被截断，LLM 真的"看不到"了 |
| 费用越来越贵 | 每次调用要传更多 input token |
| Claude 偶尔重复操作 | 被截断后看不到"这个操作已经做过了" |

---

## 4. 上下文管理策略

### 4.1 三种注入方式对比

| 方式 | 加载时机 | 共享性 | 开销 | 适用场景 |
|------|---------|--------|------|---------|
| **CLAUDE.md 全量** | 每次 API 调用 | 团队共享（提交 git） | 每次 ~1800 tokens | 高频规则 |
| **Memory 按需检索** | 语义匹配时 | 个人专属（不提交） | 匹配时才注入 | 个人知识/决策 |
| **指针懒加载** | Claude 自己读 | 团队共享（提交 git） | CLI 里 ~15 tokens，用到时才读完整文件 | 低频规则 |

### 4.2 指针懒加载模式

CLAUDE.md 里不放完整规范，只放指令：

```markdown
## Git

Before any git commit, branch, or tag operation, first read `docs/git-conventions.md`.
```

**原理**：
- 99% 的对话不涉及 git → CLAUDE.md 里只有 15 tokens 的开销
- 1% 的对话涉及 git → Claude 执行一次 Read 工具调用，获取完整规范
- `docs/git-conventions.md` 提交到 git → 团队共享

**这是一个关键模式**：利用 LLM 自己的 tool use 能力做上下文按需注入。不需要 Hook、不需要 Memory、不需要 Skill。

### 4.3 判断标准：什么放哪里

```
这条规则需要队友也遵守吗？
├── 是 → 必须在 git 仓库里
│   ├── 每次对话都要用 → CLAUDE.md 全量
│   └── 偶尔才用到 → CLAUDE.md 指针 + docs/ 详细文件
└── 否 → 只是我个人的 → Memory
    ├── 每次对话都要用 → CLAUDE.md 全量（你 fork 的版本）
    └── 偶尔才用到 → Memory（自动检索）
```

### 4.4 实战：FlashNote CLAUDE.md 审计结论

| 内容 | Token 占比 | 价值 | 建议 |
|------|-----------|------|------|
| 组件/导入/错误处理规范 | ~48% | 高（每次编码都用到） | 保留在 CLAUDE.md |
| 架构/技术栈/设计决策 | ~29% | 中（部分可推断） | 保留，精简冗余 |
| Color Palette 色值表 | ~13% | 低（Claude 用 class 名，不写色值） | 删除或移到 docs/ |
| Typography Size 对照表 | ~3% | 低（只需 class 名） | 精简 |
| Git 规范 | ~7% | 中（低频使用） | **已改为指针懒加载** ✅ |

---

## 5. 关键术语速查

| 术语 | 一句话定义 |
|------|-----------|
| **System Prompt** | 每次 API 调用携带的角色定义和行为约束，全程生效 |
| **User Message** | 用户输入或工具执行结果，来自 LLM 外部的信息 |
| **Assistant Response** | LLM 的输出——可能是纯文本，也可能包含 tool_use 意图 |
| **Tool Use** | LLM 在 Assistant Response 中表达的工具调用意图（不是实际调用） |
| **Tool Result** | Agent Loop 执行工具后产生的结果，作为 User Message 注入回对话 |
| **Agent Loop** | 你的代码——接收 LLM 输出 → 解析 tool_use → 执行工具 → 注入结果 → 再次调用 LLM |
| **Token Budget** | 上下文窗口的物理上限，需要在各层之间策略性分配 |
| **Prompt Caching** | 服务器端的计算缓存优化——省钱省时，不是 LLM 的"记忆" |
| **内存（Messages Array）** | Agent Loop 维护的消息列表——LLM "记忆"的真正载体 |
| **Memory（Claude Code 功能）** | 按语义检索、按需注入的长期知识存储系统 |
| **指针懒加载** | CLAUDE.md 中只放文件引用指令，让 Claude 自己读到用时才加载 |

---

## 6. 下一步（Part 2 预告）

- Tool Use 的深度设计：粒度、描述、错误格式、幂等性
- Agent Loop 的逐步构建（从 200 行最小版本到健壮版本）
- Tool call 故障模拟与恢复策略
