# 07 · 流式（Streaming）—— Agent Loop 的心跳，我们一直缺的那层

> 日期：2026-08-20
> 配套源码：`packages/opencode/src/session/llm.ts`、`session/llm/ai-sdk.ts`、`session/llm/native-runtime.ts`、`packages/llm/src/schema/events.ts`（事件分类 + `reduceResponseState`）。也建议对照第 1 课已读的 `session/processor.ts`（事件的消费者）。
> 说明：本课从课程表 #3-#6 之前拉前，因为它是结构性地基——opencode 的整个 processor 层就是"流式事件落地"。

## 一句话总结

**流式不是"让文字动起来"的炫技，而是 Agent Loop 的结构性要求：在一次 LLM 调用里，文本、推理、工具参数都是【边生成边到达】的，opencode 把这段"字节流"归一化成 16 种语义事件 `LLMEvent`，一条流喂给两种消费者——`processor` 把事件逐条落库/驱动工具（让 loop 活起来），`reduceResponseState` 把事件纯折叠回一条完整回复（让"答案"可被组装）。**

我们 harness 现在"一次 `create` 等完整回复"= 只用了结果、丢弃了过程。丢掉的过程恰恰是 Agent 真正的工作方式。

---

## 一、为什么 opencode 必须流式（两种理由）

### 1.1 体感理由（省服务器换体验）

一次普通回复 100+ tokens，非流式= 用户盯着空白 N 秒，流式= 300ms 内开始吐字。但这不是最重要的理由。

### 1.2 结构性理由（这才是本质）

**流式是 Agent Loop 的"心跳信号源"。** 第 1 课讲过：`processor.process` 一次只处理"一轮 LLM 调用"，它下面必须有东西逐事件驱动。看 `processor.ts` 的事件处理（第 1 课读过）和 `llm.ts:357-381` 的 stream：

```
llm.stream(input)
  → Stream<LLMEvent>
  → processor: Stream.tap(handleEvent)   // 每来一个事件 → 落库 / 工具 / 状态
    → Stream.takeUntil(() => ctx.needsCompaction)  // 溢出可中途掐流
    → Stream.runDrain
```

**"一圈不知道要多久、会发生什么"**——文本块、推理、工具调用、工具结果、步骤边界，全都在流式过程中异步到达。如果非要等完整响应，你等来的那一刻**这一轮已经结束了**，中间的推理你永远看不到，工具也早就该执行完。所以流式是"逐个处理事件"的载体。

**推理（thinking）是流式最大的受益者之一**：`reasoning-start/delta/end` 让我们能把模型内部思考实时展示给 UI（我们 harness 冒烟时见过的"─ 推理:"就是这么来的——只不过我们是一次性拿到的）。

### 1.3 工具参数也是流式的

`tool-input-start/delta/end` —— 大模型生成工具参数（比如一个很长的 diff）也是流式吐出的。UI 可以在参数还没吐完时就渲染"正在准备参数"。模型先声明"我要调 read_file"，再逐 token 报参数。

---

## 二、协议层：SSE 到底长什么样

（快速过一遍，目的是知道"语义事件"之下是什么。）

Anthropic Messages API 流式返回 `text/event-stream`，每一行 `data: {...}` 是一条事件：

```
data: {"type":"message_start",                "message": {...}}
data: {"type":"content_block_start",          "index":0, "content_block":{"type":"text","text":""}}
data: {"type":"content_block_delta",          "index":0, "delta":{"type":"text_delta","text":"你"}}
data: {"type":"content_block_delta",          "index":0, "delta":{"type":"text_delta","text":"好"}}
data: {"type":"content_block_stop",           "index":0}
data: {"type":"content_block_start",          "index":1, "content_block":{"type":"tool_use",...}}
data: {"type":"content_block_delta", "index":1, "delta":{"type":"input_json_delta","partial_json":"{\"path\""}}
data: {"type":"message_delta",                "delta":{"stop_reason":"tool_use"}, ...}
data: {"type":"message_stop"}
```

观察三点：
1. **start/delta/stop 三段式**——每个 content block 都有起止，块之间可交错。
2. **工具参数用 `input_json_delta` 增量吐**（可能被截断成半截 JSON），接收方要拼接等待完整。
3. `message_delta` 里才有 `stop_reason`——**停止原因也是流到最后的**（这正是 stop 条件双传感器的"出厂源头"）。

OpenAI 的 SSE 同理，只是以 `choices[0].delta` 的形式。opencode 的 `LLMAISDK` 就是在 AI SDK 的 `fullStream` 之上把各家的字节流归一化成统一事件。

---

## 三、三层抽象：provider → AI SDK → LLMEvent

`llm.ts` 的 `stream()`（357-381）是适配缝：

```ts
if (result.type === "native") return result.stream   // native 运行时：直接 LLMEvent
// AI SDK 运行时：fullStream 逐事件转换
const state = LLMAISDK.adapterState()
return Stream.fromAsyncIterable(result.result.fullStream, ...).pipe(
  Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),  // 一级事件 → LLMEvent
  Stream.flatMap((events) => Stream.fromIterable(events)),
)
```

`ai-sdk.ts` 的 `toLLMEvents` 是一个 16 分支的变换表：AI SDK 的 `text-start/delta/end` → `LLMEvent.textStart/...`，`tool-call` → `toolCall`，`finish-step` → `stepFinish(usage, reason)`……

**`adapterState()`（状态贯穿整个流）** 是这个转换不开玩笑的地方：

```ts
adapterState() = {
  step: 0,
  text: 0, reasoning: 0,                  // 块 id 计数器（delta 没有 id 时自增）
  currentTextID, currentReasoningID,      // 正在累积的块
  toolNames: {},                          // callID → 工具名（很多事件只有 id，要回填名字）
  copilotTotalNanoAiu,
}
```

为什么需要它？因为**增量事件的"累积上下文"必须挂在流上**：`text-delta` 本身没有"这是第几段、行号"——是 `currentTextID` 把一连串 delta 归到同一个块；`tool-result` 只有 callID，是 `toolNames` 把它翻译成"调用了哪个工具"。这就是"流式 = 需要跨事件状态"的实证：**状态不属于单个事件，属于整股流。**

---

## 四、LLMEvent 全分类（events.ts:78-226）

| 组 | 事件 | 携带 | 语义 |
|---|---|---|---|
| 步骤 | `step-start` / `step-finish` | index / reason+usage | 一次 provider 步（tool 往返一次 = 一步）起止；`step-finish` 带用量与结束原因 |
| 文本 | `text-start` / `text-delta` / `text-end` | id / text / providerMeta | 一段文本块的声明、增量、收尾 |
| 推理 | `reasoning-start` / `delta` / `end` | id / text / providerMeta | 内部推理同三段式，可附 signature（Anthropic 自适应思考） |
| 工具输入 | `tool-input-start` / `delta` / `end` | id + name / text / … | 工具参数流式吐出（`reduceResponseState` 里拼 `toolInputs`） |
| 工具结果 | `tool-call` / `tool-result` / `tool-error` | id+name+input / result / error | 工具完成；`providerExecuted` 标记 AI SDK 自动执行的那类 |
| 终态 | `finish` / `provider-error` | reason+usage / message+retryable | 整股流结束；或 provider 层错误（带 `retryable` 标记，直通 retry 层） |

**所有事件共同点：`type` 是唯一的判别标签（Effect Schema 判别联合），每个字段都有 Schema。** 事件本身也是 Schema 化的——又一次映证第 2 课"schema 是跨边界的契约"。

---

## 五、灵魂设计：一条流，两个消费者

这是本课最重要的架构模式。

```
                ┌──────────────────────────────────────────────┐
                │  LLMEvent 流（Stream<LLMEvent>）               │
                └──────────────┬───────────────────────────────┘
                               │
                ┌──────────────┴──────────────┐
                ▼                              ▼
   processor.handleEvent (副作用)       reduceResponseState (纯折叠)
   processor.ts:278-537                  events.ts:531-559
   · 逐事件落库：updatePart/Delta        · 无副作用 reduce
   · 工具生命周期：ensure/comple/fail   · text-delta → 拼到 Message
   · 用量/成本/摘要/溢出判断             · reasoning-delta → 拼到 message
   · 驱动 loop 的"活"                   · tool 输入 → 攒 callID 状态
   → 让 Agent Loop 动起来                → 让"答案"可被组装
```

### 消费者① processor —— “过程即产物”

事件到的每一刻都做一次持久化写入：
- `text-delta` → `updatePartDelta({field:"text"})`：**边生成边落库**，崩溃也不丢已生成部分，UI 实时流式渲染。
- `reasoning-delta` → 推理 part 增量。
- `tool-input-start/delta/end` → `ensureToolCall` 逐段补 input。
- `tool-call` → 状态 running + doom-loop 检测。
- `tool-result/error` → `completeToolCall` / `failToolCall`（第 1 课见过的四态流转）。
- `step-finish` → 记 cost/tokens、快照 patch、触发溢出判断 → 可能 `needsCompaction` → `takeUntil` 掐流。

**这是"过程"被当作一等公民对待。** 我们 harness 缺失的正是这里——每次 `create` 之后能把 `content` 捡回来，但过程（增量、推理、工具输入）全都丢在响应之后。

### 消费者② reduceResponseState —— "答案可以组装"

`events.ts:531-559` 是一个**纯函数 reduce**：喂一个事件、出一个新 state。16 种事件各自归位进 `textParts / reasoningParts / toolInputs / message.content`。终态由 `finish` 事件触发，得到 `LLMResponse{ message, events, usage, finishReason }`，并顺手提供 `.text` / `.reasoning` / `.toolCalls` 便捷读取。

**这个纯折叠的意义**：非流式的 `generate()` API 内部也是"把流收集起来再 reduce"——**流式和非流式共享同一套事件语义**。你在流式里看到的，和拿到完整回复后读到的，是同一条真相。

> 我们的教训：`reduceResponseState` 已经把"事件→最终消息"的纯逻辑给了我们。等我们 own 了自己的事件流，可以直接抄这个 fold。

---

## 六、native 运行时：另一条路，工具并行的证据

`llm.ts` 会选运行时：provider 是 openai/anthropic/opencode 系走 **native**（`LLMNativeRuntime`），否则走 AI SDK。

`native-runtime.ts` 里有一个值得单独看的模式（103-138）：

```ts
const settlements = yield* FiberSet.make<void>()
const results = yield* Queue.unbounded<LLMEvent>()          // 工具结果的队列
provider.stream(request)
  .pipe(
    // 遇到 tool-call 且未被 provider 执行 → 并发派发给它自己的工具执行
    Stream.flatMap((event) =>
      event.type !== "tool-call" || event.providerExecuted
        ? Stream.make(event)
        : Stream.make(event).pipe(Stream.concat(       // 工具结果稍后从队列回流
            Stream.fromEffectDrain(ToolRuntime.dispatch(tools, event).pipe(
              ... Queue.offerAll(results, dispatched.events),
              FiberSet.run(settlements, {startImmediately:true}),
            )),
          )),
    ),
    Stream.concat(Stream.fromEffectDrain(FiberSet.awaitEmpty(settlements).pipe(... Queue.end(results)))),
  )
return provider.pipe(Stream.concat(Stream.fromQueue(results)))   // 主流 + 工具结果流合并
```

要点：**工具在主流之外并发执行**（FiberSet 起协程跑 `ToolRuntime.dispatch`），结果经 Queue 回流合并进流。这就是第 1 课 cleanup 为什么"要在飞的工具最多等 250ms"的代价来源——**loop 的主循环根本不等工具，工具结果异步插队回来**。

---

## 七、中断与取消：流是可以被掐断的

`Stream.takeUntil(() => ctx.needsCompaction)`（processor.ts:644）是"提前掐流"的一种；`abortSignal`（llm.ts:321 `abortSignal: input.abort`）是另一种。

- 用户按 Esc → `AbortController.abort()` → streamText 收到 abort → 抛 `AbortError` → processor 的 `onInterrupt` → `halt(AbortError)`。
- 之所以能做到"生成到一半就停"，正是因为流把状态摊开在事件里——**随时可以放弃后半段，已落库的前半段完好**。

这也再次解释第 1 课：`cleanup` 里"仍 running 的工具"要靠 `Deferred + 250ms` 兜底，因为它跑在一条**已经被掐断的流之外**。

---

## 八、对照我们的 harness：下一步怎么接流式

我们在 `@anthropic-ai/sdk` 0.117 上可以直接消费**原生 Anthropic SSE**（不需要 AI SDK）：

```ts
const stream = client.messages.stream({ model, messages, tools, system })   // 或 create({...,stream:true})
for await (const event of stream) {
  // event.type ∈ message_start / content_block_start / content_block_delta / content_block_stop
  //            / message_delta / message_stop / ping / error
  // delta.type ∈ text_delta | input_json_delta | thinking_delta | citations_delta
}
```

把"**协议事件（raw SSE）**"升到我们自己的"**语义事件**"（学 LLMEvent：`text-start/delta/end`、`tool-input-*`、`tool-call`、`finish`），正是 AI SDK 对 Anthropic 做的那件事的一个最小版。

**我们现在的差距**（对应结构图）：
| 层 | opencode | 我们 |
|---|---|---|
| 协议消费 | AI SDK fullStream / native Http | `client.messages.create()` 一次等完 |
| 语义事件 | LLMEvent × 16 | 无 |
| 过程消费者 | processor 逐事件落库/驱动 | 无（结果一次性拿到） |
| 结果消费者 | reduceResponseState 纯折叠 | 无（SDK 已组装好） |

---

## 九、思考题（B 步讨论）

1. 为什么 `stop_reason` 只有流到最后才出现？这对第 1 课"停止条件双传感器"意味着什么？（提示：不是看完内容再决定，而是流没结束你永远是"还在生成"）
2. `adapterState` 里有 `currentTextID`、`toolNames`——为什么"增量事件"必须跨事件携带状态？把这事挪到事件里行不行？
3. `reduceResponseState` 是纯函数，`processor.handleEvent` 全是效果——为什么 opencode 故意把这俩分开？混在一起会怎样？
4. 如果我们的 harness 要做流式，最省的改法是什么——`llm.generate` 换成 `llm.stream` 返回事件，`agent-loop` 从"拿 response"改成"逐事件处理"，中间哪一环最难？（提示：工具结果的"异步回流"是否也要抄？我们没有 AI SDK 的自动执行，工具还是我们自己跑）
5. native runtime 里工具"并行执行+队列回流"——我们不做并行的话，工具结果只能顺序回流，这会让哪类场景变慢？（多工具并行）值得现在抄吗？