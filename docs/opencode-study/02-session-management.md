# 02 · Session 管理 —— 消息为何 schema 化、版本兼容(v2)、状态机、为何持久化

> 日期：2026-08-20
> 配套源码：Windows 下为 `D:\code\opencode\packages\opencode\src\session\`，macOS/Linux 下为 `~/code/opencode/packages/opencode/src/session/`。核心文件：`session.ts`、`message-v2.ts`、`message.ts`、`schema.ts`、`status.ts`、`run-state.ts`、`todo.ts`、`reminders.ts`。配套定义在 `packages/schema/src/v1/session.ts`（Part/ToolState）与 `packages/core/src/installation/version.ts`。

## 一句话总结

**OpenCode 的"Session"不是一个内存对象，而是一个持久化聚合：`Session`（元数据行）+ `Messages` + `Parts` 三层数据，用版本号自描述、用 Schema 定契约、用状态机防并发——运行时每次从数据库"重建"当前会话，而不是持有它。**

这是与我们 harness（`session.ts` 只是个数组）最根本的认知差。

---

## 一、先建立心智模型：三个"会话"不是一个东西

读代码前先分清三个词，它们都叫"session"但各管一段：

| 词 | 是什么 | 在我们读到的代码里 |
|---|---|---|
| **Session（数据）** | 持久化的会话记录：id + 元数据 + 消息 + part | `session.ts` 的 `Info`/`fromRow`/`toRow`，落 `SessionTable` |
| **SessionRunState（运行态）** | "这个会话现在有没有在跑 loop"，进程内临时 | `run-state.ts` 的 Runner + `status.ts` 的 Info |
| **Session（产品概念）** | 一次持续对话，可在终端/桌面/Web 被同时读写 | `listGlobal`、`fork`、消息分页流……依赖前面两层 |

**每个概念各司其职：数据是真源，运行态是可丢弃的临时状态，产品概念是前两者的组合。** 这就是我们第 1 课确立的"Session=被动的记录，AgentLoop=作用在它上面的流程"在工程上的展开。

---

## 二、三层数据：Session / Message / Part

### 2.1 三层各自的定位

```
Session (SessionTable 一行)
  ├─ id · slug · projectID · directory · path · parentID(session 可 fork 出子会话)
  ├─ agent · model · version · cost · tokens{input/output/reasoning/cache}
  ├─ permission · share · revert · summary · time{created/updated/compacting/archived}
  │
  Message (MessageTable 一行，SessionV1.User | SessionV1.Assistant)
  │   id(msg-*) · sessionID · time_created · data(JSON 主体)
  │   user:      role · agent · model{providerID,modelID} · format? · summary?
  │   assistant: role · parentID · agent · modelID · providerID · cost · tokens
  │              · finish? · error? · summary? · structured? · time{created,completed}
  │
  Part (PartTable 一行，SessionV1.Part 的判别联合，type 区分)
      id(prt-*) · sessionID · messageID · data(JSON)
      text | reasoning | tool | file | step-start | step-finish | patch
      | compaction | subtask | user(文件引用……)
```

**关键设计：Part 是内容【碎片】，Message 是【一次交互】的容器。** 一条 assistant 消息在流式过程中会被拆成几十个 part 增量落库（`updatePartDelta` 一次拼一段），UI 能边生成边渲染；工具调用、推理、图片、补丁、压缩标记都独立成 part。

### 2.2 ID 设计：不是自增，是"可排序的牌子"

```ts
// schema.ts —— 品牌字符串 + 时间有序 ID
export const MessageID = Schema.String.check(Schema.isStartsWith("msg")).pipe(statics(
  (s) => ({ ascending: (id?) => s.make(Identifier.ascending("message", id)) }),
))
export const PartID = ...isStartsWith("prt")...  // 同理
```

- `msg-` / `prt-` 前缀即时可见可校验；`Identifier.ascending` 生成**时间有序**的 ID（类 K-sortable，无需数据库自增）。
- 为什么？分页/排序用 ID 作 tie-breaker（`message-v2.ts` 的 `older(cursor)` 就是"time 比我小，或 time 相同但 id 比我小"）；跨库/跨进程也唯一。

### 2.3 读取=重建（hydrate）

`MessageV2.page/hydrate`（message-v2.ts:98-123, 425-467）：

```ts
// 分表存，查询时按 message → 一次 inArray 把所有 parts 拉出来拼成 WithParts
const partByMessage = new Map<string, Part[]>()
rows → { info: info(row), parts: partByMessage.get(row.id) ?? [] }
```

`WithParts = { info, parts }` 是**聚合视图**——数据库里是两张表（MessageTable + PartTable），读出来拼成一条条带 parts 的消息。这是"持久化聚合"心智模型的直接代码证据。

---

## 三、消息为何 schema 化（第一个理论点）

### 3.1 三层理由

**① 数据要越过太多边界，Schema 是每一处的契约。**
一条 part 生命周期中要经过：`processor` 生成 → `session.updatePart` 落库（JSON `data` 列）→ 事件总线发布 → server/SDK → UI 渲染。每一步都可能被第三方（代理、旧版本、手写请求）污染。Schema 在写入前校验、读取时解码：

```ts
// prompt.ts:1022 —— 保存 user 消息前先解码，坏数据记为错误但不是崩溃
const parsed = decodeMessageInfo(info, { errors: "all", propertyOrder: "original" })
if (Exit.isFailure(parsed)) { yield* Effect.logError("invalid user message before save", ...) }
```

**② 判别联合（discriminated union）= 类型安全的分发。**
所有 part 用 `type: Schema.Literal(...)` + `discriminator` 判别（packages/schema/src/v1/session.ts:315-325 的 ToolPart）；工具状态用 `status` 判别（下文状态机）。这让 `handleEvent`（processor.ts 那个大 `switch (value.type)`）能**穷尽**、编译器兜底，加新 part 类型必审。

**③ Schema 独立成包（`packages/schema`），是"改不动就改契约"的护栏。**
消息/part/状态的形状不属于某一次调用，而属于**整个产品**（app + server + SDK 共同 import）。要改形状 = 改包 + 发版，而不是随手敲。

### 3.2 schema 化的边界

（裁剪说明）Schema 不追求把每个字段都验到——`metadata: Schema.Record(String, Any)`、`input: Record(String, Any)` 这类"逃生舱"保持开放，**结构定死，内容开放**。工具入参（随 provider 千变万化）不该被 schema 掐死。

---

## 四、版本兼容(v2)（第二个理论点）

### 4.1 每份数据自带版本号

```ts
// session.ts:518 —— 每个 Session 创建时盖一个"制造者版本"
version: InstallationVersion,   // = 生成它的 opencode 版本号（packages/core/src/installation/version.ts）
```

旧版本建的会话存着旧 version，新代码读到后可以决定"要不要迁移 / 怎么解读"。

### 4.2 opencode 现在就在做 v1→v2 的迁移——这是活教材

| 层 | v1（现状，正在被替换） | v2（新形状） |
|---|---|---|
| 包名 | `@opencode-ai/core/v1/session` | `@opencode-ai/core/session`（`SessionV2.ID`） |
| 消息/part | `message-v2.ts` 读取的 DB 形状（ToolState pending/running/completed/error） | `message.ts` 新 part 类型（text/reasoning/tool-invocation/source-url/file/step-start） |
| 谁在用 | 运行时+数据库（存量数据） | 新协议/SDK（新读写） |

"v2" 的命名直接写在代码里：`SessionV1`、`MessageV2`、`SessionV2.ID`。**同一套代码里两代形状并存**——v1 承载历史数据，v2 供给新能力。

### 4.3 版本兼容的三条原则（从这段代码学到的）

1. **旧 schema 不删，只加不退。** 新代码必须能读旧数据（`fromRow` 对旧行宽容，`Schema.optional` 到处都是）。
2. **版本号在数据里，不在格式里。** 知道"制造者是谁"，才能决定迁移策略。
3. **契约独立成包。** 改 schema = 发一次新包，读旧数据的人有明确门禁（可选字段）。

> 对我们的启示：harness 现在没版本号、没 schema。什么时候需要？**一旦要落盘**（#13）就要开始想——先给消息结构加个 `version` 字段，是成本最低的第一步。

---

## 五、状态机（第三个理论点）

### 5.1 三层状态机，各管一件事

**① 对象级：ToolPart 的四态**（packages/schema/src/v1/session.ts:259-313）

```
ToolState = Union[pending, running, completed, error]，用 status 判别

pending   { input, raw }                       ← 工具刚声明（ensureToolCall 建的占位）
running   { input, title?, metadata?, time.start }      ← tool-call 事件，开始跑
completed { input, output, title, metadata, time.start/end, compacted?, attachments? }
error     { input, error, metadata?, time.start/end }
```

这条我们第 1 课见过（processor 的 `completeToolCall`/`failToolCall`）。它证明：**状态机嵌在数据结构里**,而不是散落在 if/else 里——读一个 part 就能知道它到哪一步了。

**② 会话级：Runner（run-state.ts）**

```ts
// 每个 session 唯一一个 Runner，Map<SessionID, Runner> 维护
runners: Map<SessionID, Runner>

onBusy → status.set(sessionID, busy)
onIdle → 从 Map 删除 + status.set(sessionID, idle)
```

核心约束：**单飞行（single-flight）**。`ensureRunning` 保证同一 session 同时只有一个 loop：

```ts
// 已存在的直接复用，而不是再开一个
const existing = data.runners.get(sessionID)
if (existing) return existing
```

`assertNotBusy`（或重复 start 触到 busy）→ 抛 `Session.BusyError`。这就是"一个会话只能有一个 agent 在跑"的强制力。

**③ 对外：SessionStatus（status.ts）**

```ts
// 进程内 Map；写时发事件；idle 即删除（= "空闲"标记成不含条目）
data.set(sessionID, status); events.publish(Event.Status, ...)
if (status.type === "idle") { publish(Event.Idle); data.delete(sessionID) }
```

这是给 UI / SDK 看的"这个会话在干嘛"——`busy / retry{attempt,next} / idle`。

### 5.2 三层怎么协作

```
UI 想知道会话状态 → status.ts（广播，idle 即消失）
业务要发起 loop   → run-state.ensureRunning（若 busy 就复用，不叠加）
loop 里的工具     → ToolPart 自己打状态（persist + 事件），谁都查得到
```

**一句话：对象状态长在数据里（Part.state），执行状态锁在进程里（Runner），对外状态广播出（Status）。三层解耦，各自可重建。**

---

## 六、为何持久化（第四个理论点）

### 6.1 六个理由（对应我们能看到的代码行为）

| # | 理由 | 代码证据 |
|---|---|---|
| 1 | **崩溃恢复**：loop 中途挂掉，消息/part 已逐条落库，重启续聊 | `updatePart` 单条落库、`updateMessage` 每轮落库 |
| 2 | **多客户端共享**：终端/桌面/Web 通过 server 读同一会话 | `listGlobal`、`session.messages()`、事件订阅 |
| 3 | **分支/派生子会话**：从历史任意点 fork 新会话 | `Session.fork`（读全部消息 → clone → 重排 ID） |
| 4 | **摘要/压缩**：compaction 读历史→摘要→换种方式继续 | `MessageV2.filterCompacted`、`summary.ts` |
| 5 | **审计/回放**：每个 tool 的 input/output/error、`interrupted` 标记都在 | `ToolPart.state` + `isOrphanedInterruptedTool` |
| 6 | **产品功能**：列表搜索、消息分页流、快照回退 | `listGlobal`(like title)、`page/stream` 光标分页、`revert` |

### 6.2 哲学：会话的「真相」在数据库，不在内存

`run-state` / `status` 都是 `InstanceState`（instance 级内存，可随时重建）；而 messages/parts 是**唯一真源**。内存里只有"运行时的临时影子"。

对照我们的 harness：`Session.messages` 就是全部真相，进程一退就没了。**等学到 #13 持久化，这一步要做的就是把 `Session` 换成 DB 读写。**

---

## 七、几个配套机制（第 2 课顺带认识）

### 7.1 filterCompacted + latest —— 给模型的消息不是"倒序全量"

`filterCompacted`（message-v2.ts:521-572）在压缩点做裁剪/重排：

```
[compaction-user, summary, ...retained tail..., continue-user]
```

`latest()`（582-598）从乱序（重排过）里找出"真正的最后 user / assistant / finished"，并收集**待办任务**（compaction / subtask）。这就是第 1 课 runLoop 每轮那行 `MessageV2.latest(msgs)` 的真身。

### 7.2 toModelMessages —— 会话数据到模型消息的适配层

`toModelMessagesEffect`（131-415）把 `WithParts[]` 变成 AI SDK 的 `ModelMessage[]`，处理一堆"抹平差异"的脏活：
- 工具结果的媒体（图片/PDF）在支持不了的 provider 上**抽出来当独立 user 消息**；
- pending/running 的工具 → 塞 `"[Tool execution was interrupted]"`（**防止悬空的 tool_use 块**，Anthropic 要求每个 tool_use 都有对应 tool_result）；
- 出错但非中断的 assistant 消息直接跳过；
- signed reasoning 的签名位保持对齐。

> 简而言之：**持久化的数据（怎么存）与模型的要求（怎么读）是两码事，中间永远有一层转换。**

### 7.3 Todo / Reminders —— session 级的轻量状态

- `todo.ts`：每个会话一张待办表（db 事务内 全删+重插，保顺序），UI 可读写。
- `reminders.ts`：在最新 user 消息上**注入 synthetic part**（plan/Build 切换的提示词）。注意"提醒"不是异步通知，是**进上下文之前改消息内容**——`SessionReminders.apply` 在 runLoop 里被调。

---

## 八、对照我们的 harness（为 D 步铺路）

| 维度 | opencode | harness 现状 | 什么时候补 |
|---|---|---|---|
| 消息存储 | Session/Message/Part 三层 + DB | 内存 `Anthropic.MessageParam[]` | #13 持久化 |
| 结构契约 | Schema + 版本号 + `packages/schema` | 无，直接贴 SDK 类型 | 落盘时先加 `version` 字段 |
| ID | msg-/prt- 品牌可排序 ID | 无 | 落盘时 |
| 状态机 | ToolPart 四态 / Runner / Status 三层 | 无（msg 里没有 part 状态） | 可先从工具结果上加状态 |
| 互斥 | `ensureRunning` + BusyError | 无（单进程单循环） | 多并发时 |
| 只读视图 | `getMessages()` 只读 | 有 | ✅ 已有 |
| 分页/聚合 | `page/hydrate`/`WithParts` | 无 | 消息多时 |

**最小成本的第一步**：把我们 CLI 的"记忆"从数组抽象成"读历史"+"写增量"，为将来换 DB 留口子——这正是关系 Schema 化的雏形。

---

## 九、思考题（B 步讨论）

1. 为什么 Part 要"碎片化"到一条消息几十个 part，而不是一条消息一个大字符串？（提示：流式渲染、增量落库、查询粒度）
2. `status.ts` 里 idle 是"删掉条目"而不是"存 idle"，为什么？这暴露了状态机的什么约定？
3. `ensureRunning` 的逻辑是"已存在就复用"——它防止了什么并发事故？如果删掉会怎样？（任务 A 的失控场景就在这）
4. `toModelMessages` 把 pending 工具塞 `"[Tool execution was interrupted]"`，这和第 1 课 cleanup 的 `interrupted:true` 是什么关系？
5. 版本兼容讲"旧 schema 不删只加不退"+ 可选字段大行其道——这种做意的代价是什么？（提示：字段一直是 optional，类型就永远在防御）
6. 我们的 harness Session 现在就是个数组——你觉得要给"消息"加什么最小结构，才能让将来换 DB 不用重写所有上游？