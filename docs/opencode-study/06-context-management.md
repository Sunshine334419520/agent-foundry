# 06 · 上下文管理 —— 预算 → 溢出 → 压缩 → 恢复

> 日期：2026-08-23
> 配套源码：`packages/opencode/src/session/overflow.ts`（34 行，token 预算 + 溢出判定）+ `session/compaction.ts`（601 行，压缩全流程）+ `packages/core/src/session/compaction.ts`（anchored summary 的 buildPrompt + SUMMARY_TEMPLATE）+ `session/summary.ts`（快照 diff，另一个"摘要"）+ `session/system.ts`（system prompt 组装）+ `agent/prompt/compaction.txt`（压缩 agent 人设）。
> 前置：第 1 课（loop 里消息如何进上下文）、第 2 课（消息 schema/part 结构）、第 3 课（compaction 是隐藏 agent）、第 5 课（工具输出治理）。

## 一句话总结

**上下文管理是一套"预算 → 溢出 → 压缩 → 恢复"的闭环：先用 `usable()` 算好"给上下文留多少 token、给输出留多少"（留出输出空间是铁律），超了 `isOverflow` 就触发压缩；压缩不是"整个对话让模型重写一遍"，而是"旧上下文 → 一个 agent 压成锚定摘要，最近几轮 verbatim 原样保留"，摘要体每次只增量更新（anchored summary）；还有一把更便宜的手术刀 `prune`（只清旧工具输出不重新摘要）；万一压缩都放不下（媒体过大），就 replay 用户消息 + 自动续接。** 核心哲学：**"别丢最近的工作状态，只压缩真正旧的东西。"**

---

## 一、总览：上下文的一生

```
每个 user 回合
  → 组装上下文（system.ts 的 system prompt + session 的 messages）
  → 发模型前：检查 isOverflow？
       ├─ 否 → 正常跑
       └─ 是 → compaction（旧上下文压成摘要）
                 → 压不动（媒体太大）→ replay 用户消息 + auto-continue
  中途：prune 可选（旧工具输出太肥时清掉，省得等到压缩）
```

四个文件各管一段：**overflow.ts**（预算判定）、**compaction.ts**（压缩执行）、**core compaction**（摘要 prompt 模板）、**summary.ts**（另一回事：快照 diff）、**system.ts**（system prompt 侧）。

---

## 二、Token 预算：`usable()` 的"留出输出空间"哲学

`overflow.ts:10-20` 是整个系统的地基：

```ts
const COMPACTION_BUFFER = 20_000

export function usable(input) {
  const context = input.model.limit.context
  if (context === 0) return 0
  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  // 模型声明了 input 上限 → 用它；没有 → 用 context 减掉输出空间
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
}
```

三条铁律：
1. **可用上下文 = 总上限 − 预留输出空间**。为什么要预留？因为一次请求里**输入和输出共享同一个窗口**——如果输入把窗口占满，模型一个字都吐不出来。`reserved` 默认 `min(20_000, maxOutputTokens)`——给输出留至少一条整输出的余量。
2. **`limit.input` 优先**：模型能力表里声明了输入上限就用它（有些模型 input/output 分开算），否则回退到 `context − 输出`。
3. **`context === 0` = 模型没声明上限** → 视为不可压缩，跳过整条链路。

> 心智模型：**`usable()` 回答的是"我最多能把多少历史塞进上下文还不至于让模型没地方说话"。** 这是"输出空间优先"的预算观。

---

## 三、溢出判定：`isOverflow`

`overflow.ts:22-34`：

```ts
export function isOverflow(input) {
  if (input.cfg.compaction?.auto === false) return false   // 配置关了自动压缩 → 永不过溢
  if (input.model.limit.context === 0) return false
  const count = input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}
```

- `count` = 本轮已累计的 token（输入+输出+缓存读+缓存写，或直接取 `total`）。
- **超过 `usable()` 即溢出** → 触发压缩。判断发生在"下一轮组装上下文时"——上轮结束时的用量就是本轮是否要压缩的依据。
- **`compaction.auto === false` 直接短路**：用户显式关掉自动压缩，就永远不自动触发（只留手动）。

---

## 四、压缩的触发与流程：create → process

`compaction.ts` 两个入口：

### 4.1 create()：插一个"压缩标记"用户消息（:552-575）

```ts
const msg = yield* session.updateMessage({ role: "user", model, agent, ... })
yield* session.updatePart({
  id: PartID.ascending(), messageID: msg.id, sessionID: msg.sessionID,
  type: "compaction",        // ⭐ 特殊 part：压缩标记
  auto: input.auto,
  overflow: input.overflow,
})
```

**压缩不是一个独立动作，而是"往会话里插一条带 `compaction` part 的 user 消息"**——压缩过程和普通回合走同一条 processor 管道。这就是为什么说"compaction 也是 agent 跑一遍"（第 3 课的伏笔）。

### 4.2 process()：压缩全流程（:325-550）

```
1. 找到带 compaction part 的 user 消息（压缩的"锚点"）
2. select()：决定"哪些进摘要（head）、哪些 verbatim 保留（tail）"   ← §五
3. serialize()：把 head 消息转成文本给摘要 agent                        ← §六
4. 跑 compaction agent（隐藏 agent，compaction.txt 人设）
     prompt = buildPrompt({ previousSummary, context })
     messages = [prompt, "The following is the conversation history:", conversation]
5. 结果存为一条 summary: true 的 assistant 消息（锚定摘要的载体）
6. auto + 成功 → 插入一条合成 user 消息"Continue if you have next steps..."自动续接
```

**关键点：压缩产物不是"替换掉对话"，而是"插在中间的一条摘要消息"**——旧消息还在存储里，只是**将来组装上下文时被跳过了**（`completedCompactions()` 算出哪些 index 被摘要覆盖，`select()` 时用 `hidden` 集合过滤掉，:370-374）。**压缩是可追溯的，不是破坏性的。**

---

## 五、select()：保留最近几轮 verbatim（tail turns）

`compaction.ts:224-275`——**压缩最聪明的地方**：

```ts
const limit = cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS   // 默认保留最近 2 轮
const budget = preserveRecentBudget(...)   // 默认 min(8000, max(2000, usable * 0.25))
const recent = all.slice(-limit)           // 最近 N 轮（compaction 标记的轮跳过）
// 从最近往回累加，直到塞满 budget：
for (let i = recent.length - 1; i >= 0; i--) {
  if (total + size <= budget) { keep = { start: turn.start, id: turn.id }; continue }
  const split = yield* splitTurn(...)      // 单轮超预算 → 只保留该轮的尾部
  break
}
return { head: messages.slice(0, keep.start), tail_start_id: keep.id }
```

三条语义：
1. **最近 `tail_turns` 轮（默认 2 轮）不进摘要，原样保留**。为什么？因为"最近的工作状态"是继续干活最需要的，**摘要再准也不如原文**。
2. **budget 是 `usable * 25%`**（2000~8000 之间）——最近轮保留得"够用但不过分"，省下的 75% 给旧摘要腾地方。
3. **单轮超预算 → `splitTurn` 只取那轮的尾部**（:141-164）：从该轮的靠后消息往回收，找到第一个"剩余预算能放下"的切片点。**粒度是"轮"，兜底是"消息"。**

> 心智模型：**压缩的边界不是"时间"，是"token 预算"。** 它把"最近 2 轮 + 预算内的旧轮"留给原文，其余交给摘要。

---

## 六、serialize()：把消息变成摘要 agent 的输入文本

`compaction.ts:55-86`——把结构化的消息（user/assistant/tool/reasoning/file part）**拍平成摘要 agent 能读的文本**：

```
[User]: 用户文本
[Attached image/png: screenshot.png]
[Assistant]: 助手文本
[Assistant reasoning]: 推理草稿
[Assistant tool call]: read_file({"path":"/a.ts"})
[Tool result]: 工具输出（截断到 2000 字符）
[Old tool result content cleared]          ← 被 prune 过的工具（§八）
[Tool error]: 报错
```

几个设计细节：
- **每类 part 一个明确的标签**（`[User]`/`[Tool call]`/`[Tool result]`），摘要 agent 靠标签理解结构。
- **工具输出截断到 `TOOL_OUTPUT_MAX_CHARS = 2000`**（:30/:52-53）——摘要 agent 不需要完整工具输出，只需要"大概干了什么"。
- **`[Assistant reasoning]` 也进摘要**——推理草稿可能含关键决策。
- **`[Old tool result content cleared]`**：被 prune 过的工具输出在序列化时显示占位符，不再重复送进摘要。

---

## 七、压缩 agent + anchored summary（本课明星）

### 7.1 compaction agent 只是一个隐藏 agent（第 3 课兑现）

`agent/prompt/compaction.txt`（9 行）就是它的全部人设：

```
You are an anchored context summarization assistant for coding sessions.
Summarize only the conversation history you are given. The newest turns may be kept verbatim outside your summary...
If the prompt includes a <previous-summary> block, treat it as the current anchored summary. Update it...
Always follow the exact output structure requested by the user prompt...
Do not answer the conversation itself. Do not mention that you are summarizing, compacting, or merging context.
Respond in the same language as the conversation.
```

对照第 3 课 §9 的 prompt 原理：第一行定角色、负向约束（"Do not answer"/"Do not mention"）、输出契约、**断链提示**（"don't mention you're summarizing"——摘要要装作是原对话的一部分）。**"压缩"零新代码，就是给这个 agent 一份好 prompt。**

### 7.2 anchored summary：增量更新，不是重写

`core/src/session/compaction.ts:161-168` 的 `buildPrompt`：

```ts
input.previousSummary
  ? `Update the anchored summary below using the conversation history above.
     Preserve still-true details, remove stale details, and merge in the new facts.
     <previous-summary>...上一次的摘要...</previous-summary>`
  : "Create a new anchored summary from the conversation history."
```

**每次压缩不是"重写全部"，而是"拿上次的摘要 + 新历史，增量更新"**——保留仍真的事实、删掉过期事实、合并新事实。这就是"锚定"（anchored）的含义：**摘要是一条会生长的锚，每次压一截。**

### 7.3 SUMMARY_TEMPLATE：固定输出结构（输出契约）

`SUMMARY_OUTPUT_TOKENS = 4096` + 固定 Markdown 模板：

```
## Objective            — 用户想达成什么（一两句）
## Important Details    — 约束/偏好/决策/关键事实
## Work State
  ### Completed         — 已完成的工作
  ### Active            — 正在进行的状态
  ### Blocked           — 卡点/失败命令/未知
## Next Move            — 下一步具体动作（编号列表）
## Relevant Files       — 文件路径：为什么重要
```

**摘要不是自由发挥的散文，是填一张结构化表单。** 好处：
- **机器可消费**：固定结构让下游（组装上下文时）能稳定复用。
- **填空式约束**：`"(none)"` 允许空位，agent 不会因为没内容而乱编。
- **操作导向**：`Next Move` + `Relevant Files` 是给"接着干活"的模型看的——**摘要的目的是让下一个模型能无缝继续，不是存档**。

---

## 八、prune：比压缩便宜的手术刀

`compaction.ts:279-323`——**不等上下文爆掉，先清掉最肥的旧工具输出**：

```ts
const PRUNE_MINIMUM = 20_000   // 至少能清 20k token 才动手
const PRUNE_PROTECT = 40_000   // 最近 40k token 的工具输出受保护
const PRUNE_PROTECTED_TOOLS = ["skill"]  // skill 工具的输出永不 prun
```

算法：从最新往回走，跳过最近 2 轮（`turns < 2 continue`）和已摘要的消息（`summary` 标记 break）→ 遇到超大的已完成工具输出 → 标记 `time.compacted`。**被 prune 的工具输出在 serialize 时显示 `[Old tool result content cleared]`**（§六）。

对比压缩：
| | prune | compaction |
|---|---|---|
| 成本 | 几乎零（只改 part 标记） | 贵（一次 LLM 摘要调用） |
| 粒度 | 外科手术（只清旧工具输出） | 全量（整段旧上下文变摘要） |
| 触发 | 可选，配置 `compaction.prune` | 溢出时自动 |
| 效果 | 释放 token，但保留结构 | 极大压缩，但丢细节 |

**prune 是"先做便宜的事，贵的事留到不得不用"。**

---

## 九、overflow 兜底：压缩都放不下时

`compaction.ts:346-362` + `:461-543`——**如果历史太大，连"压缩 agent 读历史"都塞不进上下文**（比如塞了大量媒体附件）：

1. **`replay`**：找到最近一条非 compaction 的 user 消息，压缩完成后**把它重新插入会话**（媒体 part 降级成 `[Attached mime: filename]` 文本占位符）。
2. **auto-continue**：插入一条 `synthetic: true` 的 user 消息：
   > "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed... Continue if you have next steps, or stop and ask for clarification..."
3. 如果连摘要 prompt 本身都超限 → 抛 `ContextOverflowError`，消息标 `finish: "error"`，返回 "stop"。

**这是"优雅降级"的最后一档**：正常跑 → 压缩 → replay+续接 → 报错。

---

## 十、summary.ts 的"另一个摘要"：快照 diff（别混淆）

`summary.ts` 里的 `summarize()`/`computeDiff()` **和上下文压缩完全无关**——它是**给 UI/审计看的"这次会话改了哪些文件"**：

```ts
// summary.ts:82-100 —— 找 step-start 和 step-finish 的快照，做 git diff
const computeDiff = (messages) => {
  for (const item of messages) {
    if (part.type === "step-start" && part.snapshot) from = part.snapshot
    if (part.type === "step-finish" && part.snapshot) to = part.snapshot
  }
  return snapshot.diffFull(from, to)   // 文件级 diff
}
```

- 存到 user 消息的 `summary.diffs` 上，UI 用来显示"这个回合改了什么文件"。
- `unquoteGitPath` 处理 git 路径的八进制转义（`"a\tb"`）。
- **它和 compaction 的"摘要 agent"是两个完全不同的东西**：一个是"改了什么文件"（快照 diff，不调 LLM），一个是"这段对话讲了什么"（调 LLM）。名字都叫 summary，别混。

---

## 十一、system.ts：上下文的上半场（system prompt 组装）

`system.ts` 负责**系统提示词**这一侧的动态注入，和 session 消息是上下文的两个半场：

```ts
// system.ts:63-99 —— environment()
`You are powered by the model named ${model.api.id}...`
`<env>`
`  Working directory: ${ctx.directory}`
`  Workspace root folder: ${ctx.worktree}`
`  Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`
`  Platform: ${process.platform}`
`  Today's date: ${new Date().toDateString()}`
`</env>`
```

- **`environment()`**：模型身份 + 环境信息（工作目录/仓库/平台/日期）。**`Today's date` 必须动态注入**——模型不知道今天几号。
- **`skills()`**（:101-113）：把可用 skill 列表注入 system prompt（verbose 版，工具 description 里是精简版——注释明说"verbose 放这里模型吸收更好"）。
- **`mcp()`**（:115-131）：MCP server 的 instructions 注入（按 permission 过滤）。
- **按模型选 prompt**（:27-45）：gpt/beast/codex/gemini/claude/kimi… 各一份专属 system prompt。

> 和本课的关系：**system prompt 是"稳定的上半场"（环境/身份/规则），session 消息是"变化的下半场"（对话/工具结果）。** 上下文管理主要管下半场，但 `Today's date` 这类动态信息也是"上下文"的一部分。

---

## 十二、本课与前后课的钩子

| 钩子 | 哪一课 |
|---|---|
| `compaction` 是 `mode: "primary", hidden: true, "*" deny` 的隐藏 agent | #3 Agent ✓ |
| compaction agent prompt 用 §9 的负向约束/输出契约 | #3 §9 ✓ |
| `serialize` 里工具输出截断 | #5 Tools（truncate）✓ |
| 消息的 part 结构（compaction part / synthetic / summary 标记） | #2 Session ✓ |
| 组装上下文发生在 runLoop | #1 Agent Loop ✓ |
| skill/mcp 注入 system prompt | #10 Skill / #9 MCP |

---

## 十三、对照我们的 harness（为 D 步铺路）

现在 harness 的 Session **永远全量发送**：`toModelMessages()` 把所有消息（含已压缩的、旧的、巨大的工具输出）原样喂给模型，没有预算、没有溢出检测、没有压缩。

| 维度 | opencode | harness 现状 | D 步可做 |
|---|---|---|---|
| token 估算 | `Token.estimate`（打包后的 JSON 估算） | 无 | `estimateTokens(text)`：字符数/4 的粗估（或引 tiktoken） |
| 预算 | `usable()` = input 上限 − 输出预留 | 无 | `modelLimit` 配置进 config.ts；`usable = input − min(20000, 输出上限)` |
| 溢出检测 | `isOverflow` 每轮检查 | 无 | Session 记录累计 token；跑前查 `used >= usable` |
| 压缩 | compaction agent + anchored summary | 无 | 最小版：超限时把旧消息序列化成文本 → 调 LLM（compaction.txt 式 prompt）→ 存一条 `summary` part → 组装时跳过已摘要段 |
| 保留最近 | tail_turns + preserve_recent 预算 | 无 | 先做：永远保留最近 2 轮 verbatim，其余可压 |
| prune | 清旧工具输出 | 无 | 暂不做（D 步先做"整段压缩"，prune 是优化） |
| 摘要模板 | SUMMARY_TEMPLATE 固定结构 | 无 | 照抄 Objective/Details/Work State/Next Move/Relevant Files |
| auto-continue | 压缩后插合成消息续接 | 无 | 暂不做（手动压缩：压完让用户再发消息） |

**D 步最小落地**：`config.ts` 加 `modelLimit`（input 上限 + 输出上限）→ `session/` 加 `estimateTokens` → `agent-loop` 每轮组装前检查 `isOverflow` → 超限触发 `compact(session)`：保留最近 2 轮 + 其余 serialize → LLM 压成固定模板摘要 → 存 `{ type: "summary", text }` 消息 → `toModelMessages` 遇到已摘要段用摘要替换。**压缩 agent 复用第 3 课的 Agent 机制**（加一个 `compaction` 隐藏 agent，`"*" deny`）。

> ⚠️ 一个必须先想清楚的点：压缩会**消耗一次 LLM 调用**（token 成本）。opencode 用 `SUMMARY_OUTPUT_TOKENS = 4096` 控制输出上限，且摘要 prompt 本身超限就放弃。我们的 harness 也要给压缩设个 token 预算，别"为了省上下文花更多 token"。

---

## 十四、思考题（B 步讨论）

1. `usable()` 为什么要"留出输出空间"（reserved）？如果不留，会发生什么？（提示：模型吐不出字）
2. "最近 2 轮 verbatim 保留、旧上下文进摘要"——为什么最近几轮不压缩？摘要再准也替代不了什么？
3. anchored summary（增量更新上次摘要）对比"每次重写全部摘要"，省了什么？又引入了什么风险？（提示：摘要越滚越旧的信息怎么办）
4. SUMMARY_TEMPLATE 要求填"Completed / Active / Blocked / Next Move / Relevant Files"——为什么是这五块？"Next Move"为什么比"Conclusion"更该有？
5. `prune` 只清旧工具输出、不动对话文本——为什么工具输出是最适合先清的东西？（提示：可重建性、保真度）
6. serialize 里"被 prune 的工具输出显示 `[Old tool result content cleared]`"——为什么不能让摘要 agent 直接看不到它？
7. `compaction.auto === false` 直接短路 isOverflow——手动压缩（用户主动触发）和自动压缩（溢出触发）的差异意味着什么？
8. 我们 harness 的 `toModelMessages()` 现在全量发送。加了"摘要替换"后，这条适配函数要改哪里？已摘要的段怎么"折叠"成摘要消息？
9. 如果压缩 agent 的摘要 prompt 本身超限（历史太大塞不进上下文），opencode 怎么兜底？我们的 harness 如果遇到，应该怎么做？
