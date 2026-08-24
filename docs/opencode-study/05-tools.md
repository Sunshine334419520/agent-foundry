# 05 · Tools —— schema 化声明 → 注册 → 执行 → 注入 的四段流水线

> 日期：2026-08-22
> 配套源码：`packages/opencode/src/tool/tool.ts`（183 行，核心 Def/Info/define/wrap）+ `tool/registry.ts`（450 行，注册 + 注入）+ `tool/json-schema.ts`（164 行，Schema→JSON Schema）+ `tool/truncate.ts`（156 行，输出截断）+ `tool/invalid.ts`（未知工具兜底）+ `session/tools.ts`（591 行，Def→AI SDK tool 的桥接 glue）+ 41 个工具与 `*.txt` 说明书。
> 前置：第 2 课（schema 化）、第 3 课（agent 的 permission 决定工具集）、第 1 课（工具在 loop 里执行回喂）。

## 一句话总结

**工具系统是一条"schema 化声明 → 注册 → 执行包装 → 按模型/agent 注入"的四段流水线：声明时用 Effect Schema 定义参数（一个 Schema 同时拿到编译期类型 + 运行时校验 + 自动 JSON Schema）；注册时内置/插件/用户三方汇入 registry；执行时每个工具统一走"解码校验 → execute → 输出截断"的包装，且必须返回 `{title, metadata, output}` 规范形状；注入时按 model/agent/permission 过滤、动态拼描述、再经模型适配层转成 AI SDK 的 tool()。** 工具是 harness 里"封闭代码、开放数据"的极致体现。

---

## 一、工具的一份"身份证"：Tool.Def

```ts
// tool.ts:55-65 —— 工具的完整定义
export interface Def<Parameters, M> {
  id: string                 // ⭐ 唯一名（read/glob/edit/task…）
  description: string        // ⭐ 给模型的说明书（来自 *.txt，prompt 注入的主体）
  parameters: Parameters     // ⭐ Effect Schema：参数契约
  jsonSchema?: JSONSchema7   // 显式覆盖时用；缺省由 parameters 自动转
  execute(args, ctx): Effect.Effect<ExecuteResult<M>>  // ⭐ 真正干活的手脚
  formatValidationError?(error): string  // 可自定义校验错误文案
}
```

四个字段分流（和第 3 课 Agent.Info 的分流思路完全同构）：
- `id` + `description` → 模型看到什么（prompt 注入）
- `parameters` → 模型怎么调用（schema 契约）+ 运行时怎么校验
- `execute` → 我们真正干什么（代码）
- 其余 → 元数据/逃生舱

`ExecuteResult` 是**统一的返回契约**：

```ts
// tool.ts:48-53
export interface ExecuteResult<M> {
  title: string    // 给 UI 展示的标题
  metadata: M      // 给 UI/审计的结构化数据（count、truncated、outputPath…）
  output: string   // ⭐ 唯一给模型看的东西（回喂进上下文）
  attachments?: FilePart[]  // 图片/PDF 等富内容（挂 session 消息）
}
```

> 心智模型：**工具的输出分两路——`output` 进模型上下文，`title`/`metadata`/`attachments` 走 UI 和消息存储。** 模型永远只见 `output`，这是"模型只吃文本"的边界。

---

## 二、声明：Effect Schema 即真相

### 2.1 一个 Schema 三用

以 glob 为例（glob.ts:10-15）：

```ts
export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The glob pattern to match files against" }),
  path: Schema.optional(Schema.String).annotate({ description: "..." }),
})
```

这一个 `Parameters` 同时服务三个消费者：
1. **编译期类型**：`Schema.Schema.Type<typeof Parameters>` 推断出 `{ pattern: string; path?: string }`——execute 的入参类型由它推导，声明和实现永不脱节。
2. **运行时校验**：`Schema.decodeUnknownEffect(parameters)` 在 execute 前解码入参，不合法直接抛 `InvalidArgumentsError`。
3. **JSON Schema 生成**：`json-schema.ts` 的 `fromSchema(parameters)` 自动转成 `JSONSchema7` 喂给模型（`.annotate({ description })` 就是模型的字段说明）。

```ts
// json-schema.ts:8-26 —— Schema → JSONSchema7，带缓存 + 规范化
export function fromSchema(schema): JSONSchema7 {
  // 1. Schema.toJsonSchemaDocument
  // 2. normalize：剥 $defs/anyOf 里的 null、拍平 allOf、integer 补安全上下界…
  // 3. inlineLocalReferences + 去重
  // 4. WeakMap 缓存（同 schema 只转一次）
}
export function fromTool(tool): JSONSchema7 {
  return tool.jsonSchema ?? fromSchema(tool.parameters)   // 显式优先，缺省自动
}
```

**normalize 在干嘛**（json-schema.ts:28-88）：Effect Schema 转出的 JSON Schema 有大量"规范化噪音"（`anyOf` 里塞 `null`、嵌套 `$ref`、`allOf` 组合、integer 无边界），而这些是**很多模型的输入 schema 拒绝接受的**——所以这里做了一整套"剪枝"：剥 null、拍平 allOf、内联 $ref、integer 补 `Number.MIN/MAX_SAFE_INTEGER` 边界。**这是"让 schema 对模型友好"的工程细节。**

### 2.2 校验失败 = 一次"重写指令"

```ts
// tool.ts:24-34
export class InvalidArgumentsError extends Schema.TaggedErrorClass<InvalidArgumentsError>()("ToolInvalidArgumentsError", {...}) {
  override get message() {
    return `The ${this.tool} tool was called with invalid arguments: ${this.detail}.\nPlease rewrite the input so it satisfies the expected schema.`
  }
}
```

**参数校验失败不是"报错"，而是"请重写"**——错误文本以 tool_result 回喂模型，模型看到"Please rewrite the input"，会修正参数再试。**这是把 schema 校验变成 agent 自愈机制的关键措辞。** 类型化错误类（TaggedErrorClass）让上游能精确匹配它做分支（比如不计重试）。

---

## 三、注册：三方汇入一个 registry

`registry.ts:224-247` 的 builtin 列表（16 个工具 + 条件工具）：

```ts
builtin: [
  tool.invalid,                                   // 未知工具兜底（见 §七）
  ...(questionEnabled ? [tool.question] : []),    // question 按 client 条件启用
  tool.shell, tool.read, tool.glob, tool.grep,
  tool.edit, tool.write, tool.task, tool.fetch,
  tool.todo, tool.search, tool.skill, tool.patch,
  ...(codeMode ? [tool.execute] : []),            // 实验性
  ...(flags.experimentalLspTool ? [tool.lsp] : []),
  ...(flags.experimentalPlanMode && cli ? [tool.plan] : []),
]
```

另外两路汇入：
- **用户自定义工具**（registry.ts:178-192）：扫 `{tool,tools}/*.{js,ts}` 目录动态 import，导出对象里的每个 `{args, description, execute}` 被识别为插件工具（`isPluginTool`），以 `namespace_id` 命名注册。
- **插件工具**（registry.ts:194-199 + fromPlugin:120-176）：`plugin.list()` 的 `p.tool`，把 Zod 参数桥接成 Effect Schema（`zodJsonSchema` + `Schema.declare`）。

关键：**没有硬编码 switch——`all()` 就是 `[...builtin, ...custom]`，谁想加工具谁就"注册"，registry 本身不判类型。**

---

## 四、执行：统一包装（wrap）

`tool.ts:99-149` 的 `wrap` 给每个工具的 execute 套上统一外壳：

```ts
toolInfo.execute = (args, ctx) => {
  return Effect.gen(function* () {
    // ① 解码校验：失败 → InvalidArgumentsError（"请重写"）
    const decoded = yield* decode(args).pipe(
      Effect.mapError((error) => new InvalidArgumentsError({ tool: id, detail: ... })),
    )
    // ② 真正执行
    const result = yield* execute(decoded, ctx)
    // ③ 输出治理：除非元数据已标 truncated，否则一律过截断
    if (result.metadata.truncated !== undefined) return result   // 工具自己声明了截断 → 不再截
    const truncated = yield* truncate.output(result.output, {}, agent)
    return { ...result, output: truncated.content, metadata: { ...result.metadata, truncated: ..., outputPath: ... } }
  })
}
```

三个执行期要点：
1. **`decode` 只编译一次**（:111）：`Schema.decodeUnknownEffect` 每次调用会新分配闭包，`wrap` 在 init 时 hoist 一次，避免每次 LLM 工具调用都重建。
2. **自动截断是强制默认**：任何工具返回的超长 output 都自动过 `truncate.output`，除非工具自己声明了 `metadata.truncated`（说明它已处理过）。
3. **`Tool.Context` 是执行期的"环境"**（tool.ts:36-46）：

```ts
type Context = {
  sessionID; messageID; agent; abort; callID?
  extra?: { ... }                        // 逃生舱（model、promptOps、bypassAgentCheck…）
  messages: SessionV1.WithParts[]        // 当前消息链（工具可读）
  metadata(input): Effect.Effect<void>   // 更新本工具的 title/metadata（流式 UI）
  ask(input): Effect.Effect<void>        // ⭐ 权限询问（#8，工具执行前问用户）
}
```

**工具不是孤立函数——它拿着会话句柄（sessionID/messages）、权限闸门（ask）、流式 UI 通道（metadata）、中断信号（abort）。**

---

## 五、prompt 注入：registry.tools() —— 过滤 + 动态描述

`registry.ts:286-335` 是"模型这一轮能看到哪些工具"的唯一出口。三步：

### 5.1 按模型过滤（硬性）

```ts
const filtered = all().filter((tool) => {
  if (tool.id === WebSearchTool.id) return webSearchEnabled(providerID, ...)   // provider 有没有搜索
  const usePatch = modelID.includes("gpt-") && !includes("oss") && !includes("gpt-4")
  if (tool.id === ApplyPatchTool.id) return usePatch      // GPT 系用 apply_patch
  if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch   // 其余用 edit/write
  return true
})
```

**同一套工具库，不同模型看到不同工具**——`gpt-4` 不看 `edit`/`write`，改看 `apply_patch`。工具注入是"按模型裁剪"的。

### 5.2 动态拼接描述（软性）

```ts
description: [
  tool.description,                                   // 工具自己的 *.txt
  tool.id === TaskTool.id ? yield* describeTask(agent) : undefined,  // ⭐ task 的动态描述
  tool.id === "execute" ? codeModeDescription : undefined,
].filter(Boolean).join("\n")
```

**`describeTask` 是 prompt 注入最精彩的一处**（registry.ts:260-273）：task 工具的 description 是**运行时生成**的——

```ts
const items = agents.list().filter((item) => item.mode !== "primary")      // 只看子代理
const filtered = items.filter((item) => Permission.evaluate("task", item.name, agent.permission).action !== "deny")  // ⭐ 被 deny 的子代理从描述里消失
const description = filtered.toSorted(...).map((item) => `- ${item.name}: ${item.description}`).join("\n")
```

**描述会随 agent 的 permission 动态变化**——同一个 task 工具，build 能看到 `- explore:`、`- general:`，但配置了 `task: { zebra: "deny" }` 的 agent 的描述里就没有 zebra（测试 registry.test.ts 验证）。**工具的说明书不是静态文本，是"数据驱动的动态渲染"。**

### 5.3 插件钩子（可改写）

```ts
yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)  // 插件可在发给模型前改写 description/parameters
```

---

## 六、模型视图：session/tools.ts 的桥接 glue

`registry.tools()` 产出的是"内部 Def"，真正喂给模型的是 `session/tools.ts` 转出的 **AI SDK `tool()`**：

```ts
// tools.ts:92-134
for (const item of yield* registry.tools({ modelID, providerID, agent, permission })) {
  const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))  // ⭐ 模型适配
  tools[item.id] = tool({
    description: item.description,
    inputSchema: jsonSchema(schema),
    execute(args, options) {
      return run.promise(Effect.gen(function* () {
        const ctx = context(args, options)     // 构建 Tool.Context
        yield* plugin.trigger("tool.execute.before", ...)
        const result = yield* item.execute(args, ctx)
        yield* plugin.trigger("tool.execute.after", ...)
        if (options.abortSignal?.aborted) yield* processor.completeToolCall(...)  // 中断也落库
        return result
      }))
    },
  })
}
```

两块拼图：
1. **`ProviderTransform.schema(model, jsonSchema)`** —— 按模型转换 schema（如某些模型要额外字段/不支持的 keyword）。**工具的 schema 在发给每个模型前都要过一层适配器。**
2. **`Tool.Context` 在此构建**（tools.ts:59-90）：`ask` 把权限请求和 `session.permission + agent.permission` 合并后送进 permission service（#8）；`metadata` 通过 `processor.updateToolCall` 流式更新 UI；`messages` 是当前消息链。
3. **MCP 工具同化**（tools.ts:390-490）：外部 MCP 工具的 execute 被包成同样的形状——`ask({ permission: key })` 统一询问、`truncate.output` 统一截断、`content`（text/image/resource）归一化成 text + attachments。**"内外工具同构"：对 loop 来说 MCP 工具和内置工具没有区别。**

---

## 七、输出治理：truncate —— 行/字节双限 + 落盘 + 委托提示

`truncate.ts` 给"模型只吃有限文本"上了一道闸：

```ts
export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024
// truncate.ts:85-141 —— output() 核心
const lines = text.split("\n")
const totalBytes = Buffer.byteLength(text, "utf-8")
if (lines.length <= maxLines && totalBytes <= maxBytes) return { content: text, truncated: false }

// 超限 → 保留前缀（direction=head）或后缀（tail），并把全文落盘
const file = yield* write(text)   // 存到 TRUNCATION_DIR
const hint = hasTaskTool(agent)
  ? `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse the Task tool to have explore agent process this file...`   // ⭐ 有 task 工具 → 委托子代理
  : `Use Grep to search the full content or Read with offset/limit...`                                                                                 // 没有 → 教它自己读
return { content: preview + "\n...N lines truncated...\n" + hint, truncated: true, outputPath: file }
```

四个值得带走的点：
1. **行数 + 字节双限**：2 条上限，任一超了就算截断。
2. **截断不是丢弃**：全文落盘到 `TRUNCATION_DIR`，模型拿到的是"预览 + 保存路径 + 怎么去看全文的提示"。
3. **提示因 agent 而异**（`hasTaskTool`）：父 agent 能 spawn 子代理 → 提示它"用 Task 委托 explore 去处理这个文件"（**省父上下文**）；不能 → 提示它自己用 Grep/Read 分页看。
4. **定时清理**：7 天保留期的 `cleanup` 后台任务。

> 这和第 4 课的"子代理省上下文"联动：**截断 + 委托子代理，是"大输出不进主上下文"的两道保险。**

---

## 八、异常与兜底：三层防线

| 层 | 机制 | 触发 | 模型看到的 |
|---|---|---|---|
| 1 | `InvalidArgumentsError`（tool.ts:24） | 参数不符 schema | "Please rewrite the input..."（自愈） |
| 2 | `invalid` 工具（invalid.ts） | **未知工具名** | "The arguments provided to the tool are invalid: ..." |
| 3 | `experimental_repairToolCall`（llm.ts:296-312） | AI SDK 校验失败 | 修复或重写 |

第 3 层最妙——模型**调了不存在的工具**时：

```ts
// llm.ts:296-312 —— AI SDK 的 tool repair 钩子
async experimental_repairToolCall(failed) {
  const lower = failed.toolCall.toolName.toLowerCase()
  if (lower !== failed.toolCall.toolName && prepared.tools[lower]) {
    return { ...failed.toolCall, toolName: lower }       // ① 大小写写错 → 修复成正确名字
  }
  return {                                               // ② 真·未知工具 → 重写成 invalid 调用
    ...failed.toolCall,
    input: JSON.stringify({ tool: failed.toolCall.toolName, error: failed.error.message }),
    toolName: "invalid",
  }
}
```

**未知工具的调用不会让模型"挂掉"——它被重写成一次 `invalid` 工具调用，工具名和错误被塞进参数，模型收到 "The arguments provided to the tool are invalid: unknown_tool ..." 从而意识到自己写错了工具名。** 这是"模型会犯错"的工程现实下的优雅兜底。（注意 `activeTools` 把 `invalid` 从模型可见列表里剔除——模型不该主动调它，它只是系统内部的重定向出口。）

---

## 九、本课与前后课的钩子

| 钩子 | 哪一课 |
|---|---|
| `parameters` 用 `Schema.Struct`、`annotate` | #2 schema 化 ✓ |
| `registry.tools({ agent, permission })` 按 agent 裁剪 | #3 Agent（工具白名单）✓ |
| `ctx.ask` 权限询问 + `Permission.evaluate` | #8 权限（判定细节留着） |
| task 工具的动态描述 + `describeTask` 过滤 | #4 子代理（子代理列表进 prompt） |
| 工具在 loop 里执行回喂（tool_result） | #1 Agent Loop ✓ |
| `attachments` 挂 FilePart | #6 上下文（富内容消息） |
| `mcp.tools()` 同化 | #9 MCP |

---

## 十、对照我们的 harness（为 D 步铺路）

我们现在 `tool/tool.ts` 是**最小版**：`TOOLS: Anthropic.Tool[]`（纯数据）+ `executeTool(name, args)` 同步 switch。对比差距：

| 维度 | opencode | harness 现状 | D 步可做 |
|---|---|---|---|
| 声明 | Effect Schema（类型+校验+schema 三合一） | `input_schema` 手写 JSON | 引入 `ToolDef` 结构 + 最小 schema 校验（手动 type guard 即可，不必引 Effect） |
| 注册 | registry：内置 + 插件 + 用户 | 数组字面量 | 抽 `registry`：`builtin` + `custom` 数组，`all()` 合并 |
| 执行 | wrap：解码→execute→截断 + ExecuteResult 契约 | 裸 switch + `return string` | 统一返回 `{ title, metadata, output }`；加截断（复用现有 slice 逻辑抽成函数） |
| 注入 | 按 model/agent 过滤 + 动态描述 | 全量暴露（第 3 课加了 agent 白名单） | `toolsFor(agent)` 取代 `resolveTools`；描述支持 `(agent) => string` 动态函数 |
| 校验错误 | InvalidArgumentsError "请重写" | 无 | executeTool 对未知工具返回 "Please rewrite..." 措辞 |
| 截断 | 双限 + 落盘 + 委托提示 | read_file/run_command 里各写一处分片 | 抽 `truncateOutput(text)` 统一收口（落盘先不做） |
| 附件 | FilePart 挂消息 | 无 | 暂不做 |

**D 步最小落地**：把 `tool/tool.ts` 重构成 `ToolDef` 数据（`{ id, description, input_schema, execute }`）+ `ToolRegistry`（`all()`/`toolsFor(agent)`）+ 统一执行包装（decode→execute→truncate→`{output}`），`executeTool` 从 switch 变成"查 registry + 调 execute"。第 3 课的 `resolveTools` 让位给 `registry.toolsFor(agent)`。`InvalidArgumentsError` 措辞 + 截断函数顺手收口。

> ⚠️ 一个要注意的取舍：opencode 用 Effect Schema 是为了"一个 schema 三用"，但这套体系重。我们的 harness 用 TypeScript 直接手写 `input_schema: { type: "object", properties, required }` 加一个运行时 `validateArgs` 就够——**schema 的价值在于"单一来源"，形式可以轻。**

---

## 十一、思考题（B 步讨论）

1. "一个 Schema 三用"（编译期类型 + 运行时校验 + JSON Schema）——如果只做其中两件，各会漏掉什么？为什么三件缺一不可？
2. `output` 给模型、`title`/`metadata` 给 UI/审计——如果反过来（模型看 metadata，UI 看 output）会出什么问题？
3. 工具说明书写在 `*.txt` 里、运行时动态拼进 description——为什么不直接写死在 `description` 字段？（提示：describeTask 的"随 permission 消失"）
4. `InvalidArgumentsError` 用"Please rewrite the input"而不是"Error: bad args"——这个措辞为什么重要？
5. `truncate` 的提示因 `hasTaskTool` 而异——有子代理时提示"委托 explore"，没有时提示"自己 Grep/Read"。这背后的工程动机是什么？
6. 未知工具被重写成 `invalid` 调用、且 `invalid` 不进模型的 `activeTools`——为什么不直接让模型"看到"一个 invalid 工具？
7. `ProviderTransform.schema(model, jsonSchema)` 意味着"schema 在发给每个模型前都要适配"——如果忽略这步会踩什么坑？（提示：某些模型不支持某些 JSON Schema keyword）
8. 我们 harness 现在的 `executeTool` 返回裸字符串。改成 `{ title, metadata, output }` 后，`agent-loop.ts` 里消费工具结果的地方要改哪些？（提示：tool_result content）
9. 如果给我们的 harness 加一个 `grep` 工具（返回可能几千行），按 opencode 的做法，它的输出应该怎么处理？"委托子代理"在我们 harness 里还不可用（#4 没实现），那 truncate 的提示应该怎么写？

---

## 十二、具体工具精读（C 步）—— 四副骨架，一颗心脏

> 精读对象：`tool/webfetch.ts`（外部 HTTP，我们要移植）、`tool/grep.ts`（外部引擎）、`tool/read.ts`（文件读取，最细心）、`tool/shell.ts`（命令执行，最复杂）。配套 `*.txt` 说明书。

### 12.1 统一骨架：所有工具同一副模样

```
Tool.define(id, Effect.gen(...))          // ① 定义
  → { description, parameters, execute }  // ② 返回三件套
execute: (params, ctx) => Effect.gen(...) // ③ execute 统一签名
  → ctx.ask(...)                          // ④ 先问权限
  → 干活                                     // ⑤ 真正执行
  → return { title, metadata, output }    // ⑥ 统一返回契约
  .pipe(Effect.orDie)                     // ⑦ 错误抛到上层
```

4 个工具全长这样，区别只在第 ⑤ 步。这印证 §五"注入"是唯一按场景变的环节。

### 12.2 WebFetch（我们要移植的）—— webfetch.ts

**参数**：`url` + `format`（`text|markdown|html`，默认 markdown，`withDecodingDefault`）+ `timeout`。

执行管线七步（:33-153）：
1. **URL 校验**：只收 `http://`/`https://` 开头，否则 throw。
2. **问权限**：`ctx.ask({ permission: "webfetch", patterns: [url] })`。
3. **协商 Accept 头**（:53-68）——按 format 拼 **q 值链**，告诉服务器"最想要 markdown，退而求其次 plain，再不行 html"：
   ```ts
   case "markdown":
     acceptHeader = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
   ```
   支持 markdown 的站点直接回 markdown，省掉本地转换。
4. **浏览器 UA**：伪装 Chrome（很多站点拒非浏览器 UA）。
5. **Cloudflare 反爬兜底**（:79-93）：403 且 `cf-mitigated: challenge` → 换诚实 UA `opencode` 重试一次（TLS 指纹问题）。
6. **双重体积闸**（:95-103）：先看 `content-length` 头 >5MB 拒；读完 body 再按实际字节验一次（防头撒谎）。超时 30s 默认 / 120s 上限（`Math.min` 钳制）。
7. **内容分发**（:106-152）：图片 → base64 塞 `attachments`（output 只写 "Image fetched successfully"）；HTML+markdown → turndown 转 markdown；HTML+text → 手写 htmlparser2 遍历（深度跳过 script/style/noscript/iframe/object/embed 块）；其它 → 原样返回。

> **移植配方**：URL 校验 → 权限占位 → 浏览器 UA + Accept 头 → 5MB 闸 → content-type 分流（图片走附件 / HTML 转文本）→ `{output, title, metadata}`。不想引 turndown 就手写 skipDepth 式文本抽取（read.ts 的写法可抄）。

### 12.3 Grep —— 复用外部引擎 + 排版（grep.ts）

- 参数：`pattern` + `path` + `include`（文件过滤 glob）。
- 执行：空 pattern throw → `ctx.ask` → **`assertExternalDirectoryEffect`**（搜索路径必须在允许目录内，对应第 3 课 external_directory）→ **`ripgrep.grep({ cwd, pattern, include, limit: 100 })`**（不自己写正则扫描，复用引擎）。
- **排版成模型友好的文本**：按文件分组、空行分隔、行号前缀——`/path/file.ts:\n  Line 42: const x = ...`，让模型一眼定位。
- **工具自己声明 `truncated`**（limit 100 到顶）→ wrap() 不再二次截断（tool.ts:131 的判断）。

### 12.4 Read —— 最"细心"的文件工具（read.ts）

- 参数：`filePath` + `offset`（1 起始）+ `limit`（默认 2000，`NonNegativeInt`）。
- **文件不存在 → "你是不是想找…"**（:76-99）：父目录模糊匹配（contains 双向），给最多 3 个候选。把"读不到"变成一次自愈。
- **二进制探测**（:182-227）：扩展名黑名单 + 内容启发式（0 字节 / 不可打印字符占比 >30%），避免二进制进上下文。
- **图片/PDF → 附件**：嗅探 mime → base64 attachments。
- **流式读行 + 三重上限**（:137-180）：TextDecoder 流式解码（注释专门解释为何不用 decodeText——会吞末尾未换行的行）；同时卡 limit 行 / 单行 2000 字符 / 累计 50KB；用标记错误 `ReadStop` 提前终止上游流（不读完整个文件再截）。
- **输出格式**（:338-352）：XML 风格结构 + 明确"接着读"指令：
  ```
  <path>/a/b.ts</path>
  <type>file</type>
  <content>
  1: import ...
  (Showing lines 1-50 of 800. Use offset=51 to continue.)
  </content>
  ```
- **LSP 预热**（:117-120）：后台 `lsp.touchFile`（失败忽略）。

> 规律：**"失败也要给模型出路"**——文件不存在给候选、超出给 next offset、截断给 how-to-continue。

### 12.5 Shell —— 语法树解析 + 权限细分 + 滚动缓冲（shell.ts）

最复杂，四层功夫：
1. **tree-sitter 解析命令**（:257-261 + :311-336）：`web-tree-sitter`（bash + powershell 两种语法，WASM），不是简单 split(" ")。
2. **从语法树提取权限敏感信息**（:378-414）：文件操作命令（rm/cp/mv/mkdir/touch/chmod… + PowerShell 别名）→ 提取路径参数 → 不在实例目录内 → 归入 `external_directory` 询问；每条命令本身 → `bash` 权限，pattern 是"命令前缀 + `*`"（`BashArity.prefix`）。**精细到命令前缀的权限粒度**。参数解析对 `-flag`、PowerShell `-Path`/`-Force`、引号/`~`/`$env:` 展开都有专门处理。
3. **流式执行 + 滚动缓冲**（:428-559）：spawn 子进程（PowerShell 用 `-Command`）；`Stream.runForEach` 收 stdout，**只保留 maxBytes×2 的尾部窗口**，超出丢头标 cut；超出 maxBytes → 切文件 sink（`trunc.write` + 追加写）。`raceAll` 三终点：**退出码 / 用户 abort / 超时**——abort 和 timeout 都 `kill({ forceKillAfter: "3 seconds" })`。
4. **输出契约**：超时/中断包成 `<shell_metadata>`，`metadata.exit` 记退出码，截断给 `outputPath`。

> 规律：**"先用语法树看清楚命令会碰什么，再决定问谁要什么权限"**——shell 最危险，权限设计最细。

### 12.6 四工具共性规律

| 规律 | 证据 |
|---|---|
| 先问权限再干活 | 4 个工具全在 execute 开头 `ctx.ask` |
| 返回契约铁打不变 | 全是 `{ title, metadata, output }` |
| `output` 排版成"模型能行动的文本" | grep 按文件分组 + 行号；read 给 next offset；webfetch 转 markdown |
| 失败也要给模型出路 | read 的 "Did you mean"、truncate 的 "委托 explore"、shell 的 "retry with larger timeout" |
| 大输出自带治理 | 工具自己声明 `truncated`，wrap 不再二次截 |
| 外部能力靠"复用引擎"不重造 | grep→ripgrep、webfetch→turndown/htmlparser2、read→LSP、shell→tree-sitter |
