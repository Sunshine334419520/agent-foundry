# 04 · 子代理 —— 独立 Session 里的"受限执行者"

> 日期：2026-08-22
> 配套源码：`packages/opencode/src/tool/task.ts`（360 行）+ `task.txt`（工具说明书）+ `packages/core/src/background-job.ts`（后台注册表）。配套测试：`test/tool/task.test.ts`（985 行，行为语义的金矿）。复用：`agent/subagent-permissions.ts`（第 3 课已精读）。
> 前置：第 1 课（loop）、第 2 课（session 的 parentID）、第 3 课（agent 类型 + mode: subagent + 权限矩阵）。权限**判定**细节仍属 #8，本课只讲"怎么 spawn、怎么隔离、怎么并行"。

## 一句话总结

**子代理不是一个新程序——它就是"在一个独立 Session 里跑同一个 Agent Loop 的受限执行者"：隔离靠"新 session 新上下文"（`sessions.create({ parentID })`），边界靠"父级 deny 下传 + 自带能力 + 防递归"三层权限合成，并行靠"同一消息多次 tool_use + 一个进程内后台任务注册表（BackgroundJob）"。**

---

## 一、本质：子代理 = 一个独立 Session

task 工具 spawn 子代理时，做的最核心一件事就是**新建一个 Session**：

```ts
// task.ts:156-172 —— 子代理会话的诞生
const nextSession =
  session ??                                            // 有 task_id → 恢复已有会话
  (yield* sessions.create({
    parentID: ctx.sessionID,                            // ⭐ 挂在父会话下
    title: params.description + ` (@${next.name} subagent)`,
    agent: next.name,                                   // ⭐ 子代理用哪个 agent 人格
    permission: [...childPermission, ...childToolDenies], // ⭐ 三层权限合成
  }))
```

关键推论：
- **隔离 = 独立消息历史**。每个子代理会话有自己的 `messages`，跑起来是**全新上下文**（`task.txt:16` 明说 "Each agent invocation starts with a fresh context"）。
- **复用同一套 loop**。子代理不是另写一套执行引擎——`ops.prompt(...)` 走的是和第 1 课完全相同的 SessionPrompt/runLoop 管道，只是喂了不同的 session、agent、model。
- **`task_id` = 恢复语义**。传了 `task_id` 就 `sessions.get(task_id)` 继续**同一个子代理会话**（保留之前的消息和工具输出），而不是开新上下文。这是"让子代理记住自己干到哪"的唯一通道。

> 心智模型：**父会话和子代理会话之间，唯一的关系是 `parentID` 这条指针 + 权限的父级下传。除此之外，子代理什么都不知道。** 这就是"隔离"在数据层的样子。

---

## 二、task 工具的参数契约（身份证）

```ts
// task.ts:43-62 —— 工具参数 schema
const BaseParameterFields = {
  description: Schema.String,   // 3-5 词的任务描述
  prompt: Schema.String,        // 任务本体（要足够详细）
  subagent_type: Schema.String, // ⭐ 派哪个 agent（explore/general/自定义…）
  task_id: Schema.optional(...) // ⭐ 恢复用（复用之前的子代理会话）
  command: Schema.optional(...)
  background: Schema.optional(Schema.Boolean), // 后台模式（experimental 门控）
}
```

`task.txt` 对 **prompt 字段**有非常具体的写作要求（:4/:16）：
1. **prompt 必须自包含**——子代理上下文是全新的，你给的 prompt 就是它的全部指令；
2. **必须明确要它返回什么**——"specify exactly what information the agent should return back to you in its final and only message to you"；
3. **必须说明要不要写代码**——"Clearly tell the agent whether you expect it to write code or just to do research"，因为子代理不知道用户的意图。

> 这跟第 3 课 §九"人设 = 完整操作手册"一脉相承：**调子代理的人，要像写操作手册一样写那条 prompt。**

---

## 三、spawn 流程逐段（task.ts:92-348）

```
┌─ ① 深度检查 ─────────────────────────────────────────────┐
│  沿 parentID 链向上数，depth >= subagent_depth(默认1) → 拒 │
├─ ② 权限询问 ─────────────────────────────────────────────┤
│  ctx.ask({ permission:"task", patterns:[subagent_type],   │
│            always:["*"] })     ← 除非 bypassAgentCheck    │
├─ ③ 解析 agent ───────────────────────────────────────────┤
│  agent.get(subagent_type)；不存在 → 报错                   │
├─ ④ 会话（恢复 or 新建）──────────────────────────────────┤
│  task_id → sessions.get；否则 sessions.create({parentID}) │
├─ ⑤ 权限合成 ─────────────────────────────────────────────┤
│  childPermission（父 deny 下传） + childToolDenies（防递归/│
│  primary_tools）去重                                      │
├─ ⑥ 模型选择 ─────────────────────────────────────────────┤
│  next.model ?? 父消息的 modelID/providerID；               │
│  variant：钉了模型则不继承，否则继承父 variant             │
└─ ⑦ 运行 ─────────────────────────────────────────────────┘
   foreground：background.wait 阻塞直到完成
   background：background.start 立刻返回（先试 extend 追加）
```

每段挑重点展开：

**① 深度限制**（:104-117）：从当前会话沿 `parentID` 一直向上走到根，`depth` 计数。`subagent_depth` 默认 **1**（即只许一层子代理，不许孙代理）。这是比权限更硬的**结构护栏**。

**② 权限询问**（:119-129）：`ctx.ask` 的 `always: ["*"]` 意味着"spawn 这个 subagent_type 要不要问用户"——第 3 课里 `task: { general: "deny" }` 这类配置，正是在这里生效（判定留 #8）。测试 `permission-task.test.ts` 证明：**子代理会话如果被 deny 了 task，`ask` 都不会走到——直接失败**（task.test.ts:391-430）。

**⑥ 模型选择**（:181-184）：子代理优先用自己的 `model`（agent 钉死模型，第 3 课 §8.4）；没钉就用**父消息的 model**（继承）。`variant` 同理：钉了模型就不继承（因为模型都换了，variant 未必兼容），否则继承父的 `xhigh` 等（测试验证了 `seen?.variant === "xhigh"`）。

---

## 四、权限边界：三层合成（收敛不放大）

```ts
// task.ts:139-172
const childPermission = deriveSubagentSessionPermission({   // ① 父 deny + external_directory 下传
  parentSessionPermission: parent.permission ?? [],
  subagent: next,
})
const childToolDenies = [                                   // ② 防递归 + 主工具禁
  ...(next.permission 没提 todowrite ? [todowrite: deny] : []),
  ...(next.permission 没提 task ? [task: deny] : []),       // ⭐ 默认禁链式 spawn
  ...(cfg.experimental.primary_tools?.map(p => [p: deny]) ?? []), // 实验性：主会话独享工具
]
// ③ 合并时去重：childToolDenies 里和 childPermission 撞车的规则被滤掉
```

三层语义（第 3 课 §五已读过第一层）：
1. **父级的 deny 和 external_directory 规则下传**——子代理只会比父级更受限，不会更大。
2. **子代理能做什么，由它自己的 permission 决定**——不是继承父级全量。测试铁证（task.test.ts:471-537）：`reviewer` agent 自己的规则声明了 `task: allow`，那么它的子会话里 `task` 就不被 deny；而 `todowrite` 没声明 → deny；实验性 `primary_tools: ["bash","read"]` → 主会话独享，子代理 bash/read 全 deny。
3. **默认禁链式 spawn**：子代理默认拿不到 `task` 和 `todowrite`。这既是防**递归爆炸**（子代理再开孙代理），也是防**todo 污染**（子代理篡改主会话的任务清单）。

> 工程表达：**父级收敛、自带能力、防递归默认拒绝——三个缺一不可的护栏。**

---

## 五、后台任务：进程内注册表（BackgroundJob）

`background-job.ts` 是一个**进程内、不持久**的任务注册表（注释 :113-119 明说："Entries are intentionally not durable: process restart or owner-scope closure loses status and interrupts live work"）。

```ts
// background-job.ts:7-19 —— 状态机
export type Status = "running" | "completed" | "error" | "cancelled"
export type Info = { id, type, title?, status, started_at, completed_at?, output?, error?, metadata? }
```

接口 8 个方法，task 工具用到 6 个：

| 方法 | 语义 | task.ts 里的用途 |
|---|---|---|
| `start` | 注册一个任务，fork 进独立 fiber 跑 | 后台/前台统一入口（:273） |
| `extend` | **往一个 running 任务追加一段工作**（串成链，不重启） | task_id 恢复后台任务（:256） |
| `wait` | 阻塞等一个任务完成（可超时） | 前台等待结果（:292） |
| `waitForPromotion` | 等任务被"提升"为后台 | 前台被用户转后台时感知（:303） |
| `promote` | running 任务 → background 标记，**不重启** | 前台转后台（:310） |
| `cancel` | 终止任务，关闭其 scope | 中断传播（:337） |

三个值得记的行为：

1. **`extend` 的"追加"语义**（:256-290）：往 running 任务的 fiber 链上再挂一段 `run`，用 `Deferred.tail` 串起来——**前一段结束才跑下一段**。测试"background task completion waits for running updates"（task.test.ts:674-746）证明：`task_id` 恢复一个还在跑的**后台**任务，是追加工作而非开新线程。
2. **`promote` 前台→后台不重启**（:310-335 + 测试 :570-634）：`onPromote` 回调触发通知注入，`runs` 恒为 1——**用户中途把前台任务转后台，正在跑的 fiber 原样保留**。
3. **`settle` 的状态收敛**（:126-171）：`Exit.isSuccess` → completed；`Cause.hasInterruptsOnly` → cancelled（只有中断算取消）；否则 error。**"被取消"和"出错"是严格区分的**。

---

## 六、并行：两种姿势

### 6.1 前台并行：同一消息多次 tool_use

`task.txt:13` 原话：**"Launch multiple agents concurrently whenever possible... to do that, use a single message with multiple tool uses"**。模型在一次回复里调用 N 个 task 工具，每个走一条独立 fiber 并发跑，全部完成后各自把结果回喂。**这是"多 agent 并行"在 agentic 世界的默认姿势——不需要任何特殊机制，就是工具调用天然支持多路。**

### 6.2 后台并行：background=true（experimental 门控）

```ts
// task.ts:96-102 —— 实验门
if (runInBackground && !flags.experimentalBackgroundSubagents)
  return yield* Effect.fail(new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"))
```

`background=true` 时 `start` 立即返回 `state="running"`，父 agent 拿到一段**警示文案**（:31-35）：
> "The task is working in the background. You will be notified automatically when it finishes. **DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work** — avoid working with the same files or topics it is using."

完成时**自动注入**父会话（`inject`，:216-243）：合成一条 `synthetic: true` 的文本消息（`renderOutput` 包好的 `<task>` 块），父 agent 下次轮到自己回复时自然看到。**父 agent 不需要轮询**——这是和"手动等结果"的本质区别。

### 6.3 结果契约：renderOutput 的 XML 块

```ts
// task.ts:64-79 —— 回传给父 agent 的统一格式
<task id="ses_xxx" state="completed">
<summary>...</summary>
<task_result>   // 或 task_error
  子代理返回的最终文本
</task_result>
</task>
```

`state` 三值：`running` / `completed` / `error`。**父 agent 靠这个块知道"谁回来了、结果在哪、是不是出错了"。**

---

## 七、取消与中断传播：一把刀砍到底

`task.ts:304-347` 的 `acquireUseRelease` 把取消做成了**级联**：

- 父工具调用的 `abort` 事件 → `onAbort()` → `ops.cancel(child)` + `background.cancel(child)`（:310-315）。
- 测试铁证（task.test.ts:304-352）：abort 触发后，`ops.cancel` 被以**子会话 id** 调用。
- **删父会话**、**删子会话**、**取消父 runState** → 后代 background 任务递归取消（:819-984 六个测试全验证）。
- 中断要区分：**主动中断（interrupts）→ cancelled；真实失败 → error**。`settle` 用 `Cause.hasInterruptsOnly` 判定。

> 设计观：**子代理的生死绑在父会话的生命周期上——父没了，子代理必须跟着停。** 不允许"父会话删了、后台任务还在偷偷跑"的野任务。

---

## 八、本课与前后课的钩子

| 钩子 | 哪一课 |
|---|---|
| `subagent_type` → `agent.get()` 拿到 `mode: "subagent"` 的 agent | #3 Agent 管理 ✓ |
| `task: { general: "deny" }` 权限配置生效于 `ctx.ask` | #8 权限（判定细节留着） |
| `deriveSubagentSessionPermission` 复用第 3 课 | #3 ✓ |
| 子代理跑的是同一个 runLoop/processor | #1 Agent Loop ✓ |
| `sessions.create({ parentID })` + `children()` 查询 | #2 Session ✓ |
| background 结果注入依赖消息 part 的 `synthetic` 标记 | #6 上下文（消息模型） |

---

## 九、对照我们的 harness（为 D 步铺路）

我们现在 `tool/tool.ts` 里 5 个工具，**没有 task**，`executeTool` 是**同步**函数。差距与 D 步最小落地：

| 维度 | opencode | harness 现状 | D 步可做 |
|---|---|---|---|
| spawn | `sessions.create({parentID, agent, permission})` | 无 | 加 `task` 工具，executeTool 里递归调 `AgentLoop.run(子Session)` |
| 隔离 | 独立会话 + 全新上下文 | 无 | 复用 Session 类：新建一个 `parentID` 指向父的会话 |
| 子代理类型 | `subagent_type` → agent.get | 只有 build/plan（都 primary） | 把 `mode: "subagent"` 加进第 3 课的 agent 数据，加一个 `general` |
| 权限边界 | 三层合成 | 无 | 先做最简：子代理会话**不继承父的工具白名单降级**，且**默认禁再 spawn**（防递归） |
| 深度 | `subagent_depth` 沿 parentID 计数 | 无 | 常量 `MAX_SUBAGENT_DEPTH = 1`，沿 parentID 链计数 |
| 并行 | 多 tool_use + BackgroundJob | 同步 executeTool | **先不做后台**：executeTool 保持同步串行（模型一次多调 task，我们同步逐个跑，天然"伪并行"） |
| 恢复 | `task_id` | 无 | 暂不做（先把"每次开新上下文"做对） |
| 结果回传 | `<task state>` XML | 无 | 子代理最终文本包一层 `<task ...>` 回喂 |

**D 步最小落地**：`tool/tool.ts` 加 `task` 工具（参数 description/prompt/subagent_type）+ `executeTool` 里对 `task` 特判：查 agent → 新建子 Session（`parentID`）→ 递归 `new AgentLoop(llm).run()` → 结果包 XML 回喂；子 Session 默认不带 `task` 工具（防递归）。需要把 `AgentLoop` 的构造改造成可传入"工具集"，且把 Session 加 `parentID` 字段。

> ⚠️ 一个必须先想清楚的点：现在 `AgentLoop.run()` 内部自己 `getAgent(session.agent)` + `resolveTools`，**执行工具还是同步的**。子代理递归调用时，**LLM 是同一份、流式事件会互相纠缠**——D 步要么接受"子代理跑完才回事件"的串行语义，要么给 AgentLoop 加"静默模式"（不 publish 或带 sessionID 前缀）。建议先做串行，事件语义留到 #7 的 bus 改造一并解决。

---

## 十、思考题（B 步讨论）

1. 为什么子代理用"独立 Session"而不是"在父会话里给消息打标记"？隔离除了防上下文污染，还买到了什么？（提示：并行、可恢复、可删除）
2. 子代理能力"由它自己 permission 决定、不继承父级全量"——如果改成"继承父级全部权限"会出什么问题？
3. 默认禁链式 spawn（子代理默认不能 `task`）防的是什么事故？"防止递归爆炸"之外还有一层（提示：todo 污染）。
4. `task.txt` 要求 prompt"自包含 + 明确返回什么 + 说清要不要写代码"——子代理上下文全新，这三点各自防什么坑？
5. background 完成时**自动注入合成消息**，而不是让父 agent 轮询或下次主动问——省掉了什么？（提示：父 agent 的注意力和 token）
6. `promote`（前台转后台不重启）解决了什么问题？如果没有它，用户想"这个任务慢点跑，先聊别的"会怎样？
7. `settle` 用"中断才算 cancelled、其它失败算 error"区分——为什么这个区分重要？（提示：父 agent 怎么回复）
8. 我们的 harness 里 `executeTool` 是同步的。要让 `task` 工具能递归 spawn，最少的改动是什么？流式事件会怎么纠缠？
9. 如果给我们的 harness 加一个 `general` 子代理（可被 task 调用、可写文件），按 opencode 的语义，它的工具白名单应该继承什么、不该继承什么？
