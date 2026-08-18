# 01 · Agent Loop —— 循环本质、停止条件与错误处理哲学

> 日期：2026-08-18
> 配套源码：Windows 下为 `D:\code\opencode\packages\opencode\src\`，macOS/Linux 下为 `~/code/opencode/packages/opencode/src/`。本课核心文件：`session/prompt.ts`、`session/processor.ts`、`session/llm.ts`、`session/retry.ts`、`session/status.ts`、`session/session.ts`。

## 一句话总结

**OpenCode 的 Agent Loop 不是"for 循环里调 API"，而是一个 `while(true)` 外层驱动器 + 一个"事件流处理器"单步 + 一个"流式管道"底层，三层各管一件事：`runLoop` 管"要不要再来一轮"，`processor` 管"这一轮 LLM 流里发生的一切"，`llm.stream` 管"怎么把 provider 的字节流变成语义事件"。**

## 一、先建立心智模型：我们的 demo vs OpenCode

阶段 0 我们手写的 loop（`demo/minimal-agent/` → `harness/src/loop.ts`）是一个 **同步、阻塞、一次一答** 的模型：

```
for step in range(max_steps):
    response = api.call(messages, tools)   # 一次性等完整回复
    messages.append(response)
    if has_tool_use(response):
        result = execute_tool(...)         # 我们逐条执行
        messages.append(result)
        continue
    else:
        return text                        # 任务完成
```

这个模型的三个隐含假设，在真实工程里全部不成立：

| demo 的隐含假设 | 真实世界的挑战 | OpenCode 的回答 |
|---|---|---|
| LLM 一次性返回完整回复 | 响应是**流式**的，文本/推理/工具调用**边生成边到达** | `llm.stream` 把字节流变成事件流，`processor` 逐事件落库 |
| 工具是我们（外层循环）执行的 | 工具可能在**流式过程中**由 AI SDK 自动执行 | 工具在 `streamText` 内部执行，processor 只是**观察并记录**每个事件 |
| 停止条件只有一个（"没有 tool_use"） | 停止理由有几十种：完成/工具调用/内容过滤/超步数/溢出/中断/权限拒绝… | `runLoop` 里用 `finish` 字段 + `Result` 枚举统一裁决 |
| 出了错就 `return` | 出错要分：可重试（网络/限流）vs 不可重试（上下文溢出 vs 真错误），还要保证不丢状态 | `SessionRetry.policy` + `halt` + `cleanup` 三层兜底 |

**核心认知转折**：阶段 0 的 loop 是"我们驱动 LLM"；OpenCode 的 loop 是"AI SDK 驱动一切，processor 记录、runLoop 决定继续与否"。工具执行权被下放给 SDK，循环的控制权被上收到 runLoop，而 processor 变成了一个**事件落地器**。

## 二、三层结构：谁在循环里做什么

```
┌─────────────────────────────────────────────────────────────┐
│ runLoop (prompt.ts 1081-1341)   外层 while(true)             │
│   · 读消息 → 找最后一个 user/assistant/task                    │
│   · 判断停止条件 → break?                                      │
│   · step++ → 造 assistant 消息 → 解析 tools → 拼 system        │
│   · 调 processor.process() → 得 Result ("stop"/"continue"/"compact") │
│   · 按 Result 决定：break / continue / 触发 compaction          │
└──────────────┬──────────────────────────────────────────────┘
               │ 每轮调一次
┌──────────────▼──────────────────────────────────────────────┐
│ processor.process (processor.ts 627-683)  单步               │
│   · 把 llm.stream 的 LLMEvent 逐个 handleEvent() 落地         │
│   · 维护 ctx：toolcalls / shouldBreak / needsCompaction /     │
│     currentText / reasoningMap / snapshot                    │
│   · 包上 retry → halt → cleanup 三层                                   │
│   · 结束时返回 Result                                         │
└──────────────┬──────────────────────────────────────────────┘
               │ 每轮一次流
┌──────────────▼──────────────────────────────────────────────┐
│ llm.stream (llm.ts 357-381)   底层流                         │
│   · streamText(...)  AI SDK 拥有 provider 执行 + 工具派发      │
│   · fullStream → LLMAISDK.toLLMEvents → LLMEvent 流          │
│   · 事件类型：text-* / reasoning-* / tool-input-* / tool-call │
│     / tool-result / tool-error / step-* / provider-error      │
└──────────────────────────────────────────────────────────────┘
```

**关键洞察**：
- 三层之间是**一个流**：`runLoop` 每次迭代消费一个 `LLMEvent` 流。
- `processor.process` 返回值是 `Result = "compact" | "stop" | "continue"`（processor.ts:30）——单步不自己决定退出，**把决定权交还 runLoop**。
- `Stream.takeUntil(() => ctx.needsCompaction)`（processor.ts:644）——流可以在被截断，因为单步内部的"提前停止"只有 compaction 一种理由。

## 三、循环本质

### 3.1 循环的不是"步骤"，而是"从最近一条 user 消息出发的响应链"

`runLoop` 每轮做同一件事：**以"最近一条真正需要回答的 user 消息"为起点，生成一条新的 assistant 消息，让 LLM 处理当前全部上下文**。工具结果会作为新的 user 消息追回历史，于是下一轮"最近 user"就变成了工具结果——循环就"跑起来了"。

### 3.2 每轮新建 assistant 消息，而不是复用

```ts
// prompt.ts 1186-1201：每轮都 updateMessage 一条全新的 assistant
const msg: SessionV1.Assistant = { id: MessageID.ascending(), parentID: lastUser.id, ... }
yield* sessions.updateMessage(msg)
```

这是与 demo 最大的结构差异：demo 只维护一个 `messages` 数组；OpenCode 把**每轮响应都持久化成一条消息**，消息里有 `id/parentID` 构成链。好处：
1. 中间任何一步崩溃，历史都在数据库里，可恢复（`fork` 也依赖这个）。
2. UI 能流式渲染每条消息的每个 part。
3. `parentID` 让"最后一次完整回答"可精确定位（停止条件的依据之一）。

### 3.3 循环的"记忆"是数据库，不是数组

`MessageV2.filterCompactedEffect(sessionID)` 每轮从库里读全量消息（prompt.ts:1092）。`session.ts` 的 `messages()` 负责分页读取。**持久化是循环的基石**，这也是为什么课程表 #13 持久化在后面——现在先知道"循环每轮都从数据库重新读"。

## 四、停止条件（本课最核心）

### 4.1 停止条件的**唯一裁决点**：`lastAssistant.finish`

```ts
// prompt.ts 1100-1130：每轮开头就检查要不要退出
if (
  lastAssistant?.finish &&                                    // ① 有结束理由
  !["tool-calls"].includes(lastAssistant.finish) &&          // ② 不是"还想调工具"
  !hasToolCalls &&                                           // ③ 没有未执行的工具调用
  lastAssistant.parentID === lastUser.id                     // ④ 它确实回答的是最近这条 user
) break
```

`finish` 是 assistant 消息上的一个字段，由 `step-finish` 事件写入（processor.ts:443 `ctx.assistantMessage.finish = value.reason`）。它等价于 provider 的 `stop_reason`，但被 OpenCode 规范化过。**"循环结束" = "最近一条 assistant 消息有了一个非 tool-calls 的 finish，且没有悬空的工具调用"。**

为什么 demo 的"没有 tool_use 就结束"不够？因为某些 provider 会在**有工具调用时也返回 `stop`**（prompt.ts:1103-1105 的注释明说）。所以必须用"finish ≠ tool-calls **且** 消息里没有未执行的 tool part"双条件。

### 4.2 单步返回的 Result 是第二层裁决

`processor.process` 返回的 `Result` 在 runLoop 里这样用（prompt.ts:1319-1329）：

```ts
if (result === "stop")    return "break"        // 权限拒绝 / 出错 → 停
if (result === "compact") { compaction.create(...) }  // 溢出 → 触发压缩，继续下一轮
return "continue"                                // 默认：再来一轮
```

- **stop**：来自 `ctx.blocked || ctx.assistantMessage.error`（processor.ts:680）。权限拒绝（PermissionV1.RejectedError）或问题被拒、或出错，都停。
- **compact**：单步流被 `takeUntil` 截断（上下文溢出），需要压缩后再继续。
- **continue**：默认。

### 4.3 硬停止：maxSteps

`agent.steps` 是 agent 的步数上限（默认 Infinity，即不限制）。注意实现很巧妙（prompt.ts:1178-1282）：

```ts
const maxSteps = agent.steps ?? Infinity
const isLastStep = step >= maxSteps
messages: [...modelMsgs, ...(isLastStep ? [{ role: "assistant", content: MAX_STEPS_PROMPT }] : [])]
```

**不是直接 break，而是往消息里塞一条假的 assistant 消息，内容是"这是最后一步了，请直接给出最终答案"**。让模型自己收敛，而不是硬切。这是"软限制"哲学：能靠 prompt 达成的事，不靠代码。

### 4.4 其它提前退出路径

| 路径 | 触发 | 代码 |
|---|---|---|
| 内容过滤 | provider 返回 content-filter | prompt.ts:1301-1307 → 记 error + break |
| structured output 失败 | json_schema 格式但模型没产出 | prompt.ts:1309-1315 → StructuredOutputError + break |
| 成功产出 structured | 模型调了 StructuredOutput 工具 | prompt.ts:1288-1293 → break |
| 无回复 | `noReply === true` | prompt.ts:1069（根本不进循环） |

### 4.5 为什么停止条件这么复杂？

**因为"停止"在真实世界里不是一个布尔，而是一个分类问题**：
- 正常完成（finish=stop）
- 还想干活（finish=tool-calls）
- 想干活但没活干（悬空 tool part / interrupted orphan）
- 被内容过滤器打断（finish=content-filter）
- 被权限拒绝（blocked）
- 出错（error）
- 上下文溢出（compact）
- 步数到头（isLastStep）

OpenCode 的做法：**把分类结果集中到 `finish` 字段 + `Result` 枚举**，让所有分支都在一处裁决，循环体只认这两个信号。

## 五、错误处理哲学

### 5.1 分层：retry → halt → cleanup

`processor.process` 的管道（processor.ts:647-677）：

```
Effect.onInterrupt(aborted → halt(AbortError))     // 用户中断
  → Effect.catchCauseIf(非纯中断 → Effect.fail)     // 中断异常特殊对待
  → Effect.retry(SessionRetry.policy(...))          // 可重试错误 → 退避重试
  → Effect.catch(halt)                              // 不可重试 → halt 收尾
  → Effect.ensuring(cleanup())                      // 无论成败，清理现场
```

**哲学一句话：可重试的绝不放弃，不可重试的绝不裸抛，无论如何都留一个干净的现场。**

### 5.2 retry：什么可重试，什么不可重试

`retry.ts` 的核心是 `retryable()`（retry.ts:84-154）：

- **不可重试**：`ContextOverflowError`（上下文溢出，重试也没用，交给 compaction）；非 API 错误且消息不匹配任何模式。
- **可重试**：HTTP 429/5xx；消息匹配限流/网络/超时模式（retry.ts:33-40 一长串正则）；`isRetryable` 标记；`Retry-After` 头。
- 特殊业务分支：免费额度用尽（GO_UPSELL）→ 返回带 `action` 的提示，UI 借此展示"订阅"按钮。

退避算法（retry.ts:79-82）：`base = 2000 × 2^(attempt-1)`，加 25% 抖动；有 `Retry-After` 头就听它的；上限 30 秒（无头时）；最多 5 次。**尊重 provider 的节流信号，是工程级循环的基本修养。**

### 5.3 halt：把错误落成状态，而不是吞掉

```ts
// processor.ts 599-625
const halt = (e) => {
  if (ContextOverflowError) {
    if (auto 被禁用且无 summary) { 记 error + finish=error + 状态 idle + 返回 }
    ctx.needsCompaction = true       // 否则走压缩流程
  }
  assistantMessage.error = 错误对象
  publish(Session.Event.Error)       // 事件总线广播给 UI
  status.set(sessionID, idle)        // 状态机复位
}
```

注意：**上下文溢出不是错误，是一种流程**——它走 `needsCompaction`，由上层触发压缩，压缩完**继续循环**。真正致命的错误才 `finish = "error"`。这是"溢出 ≠ 失败"的哲学。

### 5.4 cleanup：兜底一切未完成的现场

```ts
// processor.ts 539-597
cleanup: 快照→patch；currentText/reasoning 补 end 时间；等待在飞工具 ≤250ms；
          仍在 running 的工具 part → status=error + interrupted=true
```

`interrupted=true` 这个标记很关键：`isOrphanedInterruptedTool`（prompt.ts:96-100）会识别它，**避免把中断的工具当作待执行任务**触发下一轮。中断也要"留痕"，不能静默消失。

### 5.5 用户中断：AbortError 与 `aborted` 标记

`processor.ts:115` 维护 `aborted`；中断时 `halt(new DOMException("Aborted", "AbortError"))`（processor.ts:652）。`MessageV2.fromError` 会带上 `aborted` 标记，这样"被打断"和"真出错"在界面上区分开。

## 六、工具调用的状态机（Tool Part 生命周期）

processor 里每个工具调用是一条 `ToolPart`，状态机是（processor.ts 各事件 handler）：

```
tool-input-start/tool-call → ensureToolCall() 建 part（status=pending）
    ↓
tool-call 事件 → updateToolCall() → status=running + input
    ↓
tool-result / tool-error → completeToolCall() / failToolCall()
    status=completed / error（记 title/metadata/output/error/时间）
```

辅助状态 `toolcalls: Record<id, ToolCall>`（processor.ts:67-69）把 `Deferred` 挂在每个调用上——工具完成/失败时 `Deferred.succeed`，供 `cleanup` 等待在飞工具。**这就是"循环与异步工具执行握手"的机制**：SDK 在流里执行工具，processor 靠 Deferred 感知完成。

为什么工具由 SDK 执行而不是我们执行（processor.ts:100-102 注释：SDK 可能在发 step-start 事件前就内部执行工具）？因为 AI SDK 的 `streamText` 原生支持"工具自动执行 + 结果自动回填"，OpenCode 选择**让 SDK 拥有执行权，自己只做记录与裁决**——省去自己写工具调度器的同时，还能拿到每个调用的完整生命周期事件。

## 七、Doom-Loop 检测：防"复读机"

`DOOM_LOOP_THRESHOLD = 3`（processor.ts:29）。在 `tool-call` 事件里（processor.ts:353-380）：

```ts
const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)
if (最近3条全是同名工具 && input 完全相同 && 都非 pending) {
  yield* permission.ask({ permission: "doom_loop", ... })   // 问用户
}
```

**同一个工具、同样的入参、连续 3 次** → 判定为 doom loop，向用户申请权限。这是阶段 0 里我们手写 `LoopDetector` 的工程化版本——但它没有"硬编码打断"，而是把它变成**一次权限请求**，把裁决权交给人。哲学：**循环检测是风险信号，不是自动终止器。**

## 八、状态机与并发

### 8.1 会话状态

`status.ts` 维护 `Map<SessionID, Info>`，`Info = { type: "idle" | "busy" | "retry" | ... }`：
- 进循环前 `set(busy)`（prompt.ts:1089）、processor 里也 `set(busy)`（processor.ts:639）
- 出错/退出 → `set(idle)`
- 重试 → `set(retry, { attempt, next, ... })`（processor.ts:664-673）

**循环的每一步都向外广播自己的状态**——这是 UI 能显示 spinner/进度、SDK 能阻塞并发请求的基础。

### 8.2 并发互斥

`loop()` 被 `state.ensureRunning(...)` 包住（prompt.ts:1346）：

```ts
return yield* state.ensureRunning(input.sessionID, lastAssistant(input.sessionID), runLoop(input.sessionID))
```

同一 session 同时只能有一个 loop 在跑；若已在跑，返回当前状态而非叠一个（这就是 `Session.BusyError` 的来源）。**Agent Loop 是有状态、互斥的资源，不是无状态的函数。**

## 九、我们的 harness 差距在哪（为 D 步铺路）

对照 `harness/src/loop.ts` 与 OpenCode：

| 维度 | harness 现状 | OpenCode | 下一步要补 |
|---|---|---|---|
| 记忆 | 内存 `messages` 数组 | 数据库持久化 + 每轮重读 | 先不用全上，但要知道差异 |
| 响应 | 一次性等完整回复 | 流式事件 + 边生成边落库 | 流式是本课延伸 |
| 工具执行 | 我们循环里执行 | SDK 内执行 + processor 记录 | 可保持"我们自己执行"，但生命周期要有状态 |
| 停止 | 只看有无 tool_use | finish 字段 + Result + maxSteps | **最值得抄：finish 语义** |
| 错误 | try/catch 吞掉返回字符串 | retry/halt/cleanup 分层 | 学分层哲学 |
| 循环检测 | 手写 LoopDetector | doom_loop → 权限请求 | 学"转权限"思路 |
| 状态 | 无 | busy/idle/retry 广播 | 加个简单状态即可 |

## 十、思考题（B 步讨论用）

1. 为什么停止条件要同时看 `finish` 和 `hasToolCalls`，只用一个不行吗？
2. "maxSteps 到了不直接 break，而是塞 MAX_STEPS_PROMPT"——这种软限制的取舍是什么？
3. 上下文溢出为什么算"流程"不算"错误"？如果 auto-compaction 被禁用，OpenCode 会怎么处理？
4. cleanup 为什么要等 250ms 而不是立刻清理？这暴露了什么工程现实？
5. doom_loop 检测为什么要 `JSON.stringify(input)` 比较而不是只比较工具名？
6. 我们的 harness 现在"没有 tool_use 就结束"，在什么真实场景下会挂？（提示：provider 返回 stop 但消息里有 tool call）
