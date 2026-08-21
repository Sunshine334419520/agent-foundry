# 03 · Agent 管理 —— 模式 = 人设 + 工具权限

> 日期：2026-08-21
> 配套源码：`packages/opencode/src/agent/agent.ts`（453 行）、`agent/subagent-permissions.ts`（27 行）。配套：`@opencode-ai/core/v1/permission`（权限规则集）。
> 前置：第 2 课（schema 化/版本）、第 8 课（权限）在此有前置引用——本课先讲"agent 怎么组成"，权限**判定**细节留给 #8。

## 一句话总结

**一个 Agent 就是一对「人设 + 工具权限」：`prompt` 字段是它的人格（系统提示词），`permission` 字段是它的行为能力（工具权限矩阵），再加 model/temperature/steps 等调参——内置 agent、用户自定义 agent、甚至 title/summary/compaction 这类内部工具 agent，全部统一走这一个 `Info` 结构。**

---

## 一、Infomation：一个 Agent 的"身份证"

```ts
// agent.ts:35-56 —— Schema 定义的 Agent.Info
export const Info = Schema.Struct({
  name: Schema.String,                        // 唯一名（build / plan / explore ...）
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),  // 用途分类
  native: Schema.optional(Schema.Boolean),    // 是否内置
  hidden: Schema.optional(Schema.Boolean),    // 是否对用户隐藏
  topP: ..., temperature: ..., color: ...,    // 调参 + 展示
  permission: PermissionV1.Ruleset,           // ⭐ 工具权限矩阵
  model: Schema.optional({ modelID, providerID }),  // 可选指定模型
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),     // ⭐ 人设（系统提示词）
  options: Schema.Record(Schema.String, Schema.Unknown),  // 逃生舱
  steps: Schema.optional(Schema.Finite),      // 第 1 课的 maxSteps 就来自这
})
```

三个字段分流：
- **`prompt`** → 模型收到的人格（system prompt）
- **`permission`** → 它能碰哪些工具（权限矩阵）
- **其余** → 调参（温度/模型/步数/颜色）与元信息（mode/native/hidden）

**心智模型：Agent 不是"一种程序",是"一份配置数据"。** 第 1 课你看到的 `agent.steps`、第 1 课的"每轮按 agent 解析工具集"、会话里存的 `info.agent`，全都指向这张身份证。

`mode` 三值语义（从用法推得）：
| 值 | 含义 |
|---|---|
| `primary` | 可作主会话默认 agent（`defaultInfo` 要求非 subagent 且非 hidden） |
| `subagent` | 只能经 task 工具被派生调用，不能当默认 |
| `all` | 两者皆可（用户配置文件里新建 agent 的默认值） |

---

## 二、模式 = 人设 + 工具权限：代码证据

### 2.1 一个"锁死一切、只开工具的" agent：explore

```ts
// agent.ts:196-218 —— explore 子代理
permission: Permission.merge(
  defaults,
  Permission.fromConfig({
    "*": "deny",                    // 默认全禁
    grep: "allow", glob: "allow", list: "allow",
    bash: "allow", webfetch: "allow", websearch: "allow",
    read: "allow",
    external_directory: readonlyExternalDirectory,
  }),
  user,
),
prompt: PROMPT_EXPLORE,             // 专门写好的探索人格
mode: "subagent",
```

**explore = 一套只允许搜索/读取的权限 + 一个"怎么找文件"的系统提示词。** 没有新代码逻辑，全是配置。这就是"模式"的含义：换人设+换权限=换个 agent。

### 2.2 plan 模式的"不许改代码"：

```ts
// agent.ts:156-181 —— plan 不允许编辑
permission: Permission.merge(defaults, Permission.fromConfig({
  question: "allow", plan_exit: "allow",
  task: { general: "deny" },
  edit: {
    "*": "deny",
    [path.join(".opencode", "plans", "*.md")]: "allow",   // 只许写 plan 文件
    ...
  },
}), user),
```

`edit` 是一个**按路径 pattern 的矩阵**：`*` deny，但 plan 目录下的 `.md` allow。**权限能精细到"允许写哪类文件"**。

### 2.3 内部工具也是 agent：title / summary / compaction

```ts
title:     { mode: "primary", hidden: true, temperature: 0.5, "*" 全 deny, prompt: PROMPT_TITLE }
summary:   { mode: "primary", hidden: true, "*" 全 deny, prompt: PROMPT_SUMMARY }
compaction:{ mode: "primary", hidden: true, "*" 全 deny, prompt: PROMPT_COMPACTION }
```

**起标题、写摘要、压缩对话——这些"内部杂活"根本不用写新代码，就是"一个只给 system prompt、锁死工具的隐藏 agent"。** 第 1 课 `title()`、`summary.summarize()`、`compaction` 背后的模型调用，都是"拿一个 agent 跑一遍"。

> 这是最该带走的设计观：**能力 = 人格 × 权限，别为每种角色单开一条代码路径。**

---

## 三、权限矩阵是数据，不是代码

### 3.1 三要素：permission / pattern / action

`PermissionV1.Ruleset = Rule[]`，每条规则 `{ permission, pattern, action: "allow"|"ask"|"deny" }`：
- `permission` = 工具名或权限类别（`read`/`edit`/`bash`/`doom_loop`/`question`/`plan_enter`...）
- `pattern` = 匹配（`*` 全局，或文件路径 glob 比如 `*.env`）
- `action` = 该匹配下的处置：**allow（放行）/ ask（问用户）/ deny（禁止）**

### 3.2 配置是嵌套对象，运行时展开成规则数组

`Permission.fromConfig` 把这类**声明式描述**展开成规则：

```ts
// agent.ts:119-136 —— 全局默认矩阵（defaults）
{
  "*": "allow",                 // 默认一切放行
  doom_loop: "ask",             // 复读机问用户（第1课）
  external_directory: { "*": "ask", "…/tmp/*": "allow", "…/skills/*": "allow" },
  question: "deny",
  plan_enter: "deny", plan_exit: "deny",
  read: {  "*": "allow", "*.env": "ask", "*.env.*": "ask" },   // 敏感文件要问
}
```

**默认哲学一目了然：默认放行、危险动作转 ask、机密文件例外、question/plan 默认 deny。** 权限不是"能干什么的清单"，而是"在默认允许之上叠加例外"。安全默认 + 少量特例。

### 3.3 合并：Permission.merge

`build` = `merge(defaults, {question:allow, plan_enter:allow}, user)` ——**三层叠加**：全局默认 → agent 自身调整 → 用户配置。谁后合谁覆盖。这个组合性让"用户改一个 agent"只需要写差异，不用重述全部。

### 3.4 强制兜底

```ts
// agent.ts:296-310 —— 除非显式 deny，否则 Truncate.GLOB（长输出截断目录）始终放行
```

防止权限配置破坏内部功能——**"默认放行"之外还有"不可配置的底线"**。

---

## 四、用户如何得到自定义 agent：配置合并 与 生成

### 4.1 配置合并（agent.ts:267-294）

用户在 opencode.json 写 `agent` 字段，逐个覆盖（disable 删除 / 字段级覆盖 / permission merge）：

```ts
for (const [key, value] of Object.entries(cfg.agent ?? {})) {
  if (value.disable) { delete agents[key]; continue }
  if (!item) item = agents[key] = { name: key, mode: "all", permission: merge(defaults, user), options: {} }
  item.model = ...; item.prompt = value.prompt ?? item.prompt; item.steps = value.steps ?? ...
  item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
}
```

**没有"注册表"、没有硬编码 switch——内置 agent 只是一份初始数据，用户配置是差异补丁。** 想加一个新 agent？新建一个 key 即可（`mode:"all"`，权限=defaults+user）。

### 4.2 生成（agent.generate）

`agent.ts:368-436`：用户给一句描述 → `generateObject` 让模型按 `GeneratedAgent{identifier, whenToUse, systemPrompt}` schema 产出 → 注入配置。**让模型自己写 agent**（高级功能，先知道存在）。

---

## 五、子代理的权限边界（subagent-permissions.ts）

task 工具 spawn 子代理时，用 `deriveSubagentSessionPermission` 合成子代理会话权限：

```ts
function deriveSubagentSessionPermission({ parentSessionPermission, subagent }): Ruleset {
  return [
    ...parentSessionPermission.filter(                       // ① 父级的 deny + external_directory 下传
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    ...(canTodo ? [] : [{ todowrite, "*", deny }]),           // ② 子代理自己没开 todowrite → 默认禁
    ...(canTask ? [] : [{ task, "*", deny }]),                // ③ 同理 task（防止子代理再开子代理）
  ]
}
```

三条语义：
1. **父级禁令向下传**（deny 加 external_directory），权限只会收敛不会放大。
2. **子代理能做什么由它自己的 permission 决定**，不是继承父级全量（opencode 注释明说）。
3. **默认禁链式 spawn**：子代理默认不能 `task`（再开孙子）、不能 `todowrite`，除非它自己明确允许。

这是"**子代理是受限的执行者**"的工程表达——父级限制 + 子代理自带能力 + 防递归默认拒绝。

---

## 六、本课与前后课的钩子

| 钩子 | 哪一课 |
|---|---|
| `agent.steps` → maxSteps 软限制 | #1 Agent Loop ✓ 已见 |
| `permission` 用 Ruleset 数据、合并语义 | #8 权限（判定细节留着） |
| `Agent.Info` 是 Schema.Struct、`mode` 用 Literals | #2 schema 化 ✓ |
| 会话存 `info.agent`、每轮 `agents.get(...)` | #2 Session / runLoop 里那行 `agents.get(lastUser.agent)` |
| `hidden` agent 跑 title/summary/compaction | #6 上下文（summary agent） |

---

## 七、对照我们的 harness（为 D 步铺路）

我们现在 `loop/agent-loop.ts` 里 `SYSTEM_PROMPT` 是**写死的常量**——没有"agent"这个词：

| 维度 | opencode | harness 现状 | D 步可做 |
|---|---|---|---|
| 模型 | Agent.Info（人设+权限+调参） | 固定 SYSTEM_PROMPT | 引入 `Agent` 类型 + 默认 `build` |
| 权限 | Ruleset 矩阵 | 全部工具对 agent 全开 | 先做最简单的：agent 带 `prompt` 字段，`permission` 留空（=全开） |
| 多角色 | build/plan/explore 内置 + 用户配置 | 无 | 加一个 `build` + `plan`（不许 edit）演示"换人设换权限" |
| 选中 | `default_agent` 配置 / session.agent | 无 | CLI 启动时选 agent（`/agent` 命令） |
| 内部工具 agent | title/summary/compaction | 无 | 暂不做（用到再说） |

**D 步最小落地**：把 `SystemPrompt` 从 agent-loop 的常量里拿出来，变成 `Agent` 数据（`{ prompt, ... }`），agent-loop 按当前 agent 取 prompt；CLI 加 `/agent <name>` 切换（演示 build↔plan 两种人格），session 记录当前 agent。

---

## 八、调参原理：Agent 是一层"差异覆盖"

> 依据 `session/llm/request.ts`（`LLMRequestPrep.prepare`，从 agent 组装请求参数的那一段）。

### 8.1 一把钥：`agent.字段 ?? 模型默认`

采样参数不是"agent 定义新值"，而是**在模型默认之上提供覆盖**：

```ts
// request.ts:124-128
temperature: model.capabilities.temperature
  ? (agent.temperature ?? ProviderTransform.temperature(model))  // agent 写了用它，否则模型默认
  : undefined,                    // 模型能力表说"不支持温度"→ 干脆不传
topP: agent.topP ?? ProviderTransform.topP(model),
topK: ProviderTransform.topK(model),   // 连 agent 字段都没有——只有模型层
```

推断出的三条原则：

1. **缺省即默认**：空 agent == 模型自己的全套默认。设了才覆盖。
2. **能力表说了算**：模型声明自己支不支持，不支持就不传（避免发给不认识参数的 provider）。
3. **不是每个参数都能到 agent 层**（topK/maxOutputTokens 就只活在模型层）——**分层刻意为之**：模型层放"每个 provider 都需要的参数"，agent 层只放"值得让角色调的"。

### 8.2 逃生舱的层级：options 的四层 merge

`request.ts:84-91`：

```ts
const base   = ProviderTransform.options({ model, providerOptions })   // ① provider 底座
const options = mergeOptions(                                        // mergeDeep，深合并
  mergeOptions(mergeOptions(base, model.options), agent.options),    // ② 模型默认 → ③ agent.options
  variant,                                                           // ④ variant（最高）
)
```

**四层，越靠后越能赢。** 意义：
- provider 专属参数（reasoning effort、缓存策略……）不用动模型代码，往对应层塞即可；
- `mergeDeep` 意味着可以**局部覆盖嵌套结构**，而不是整块替换；
- agent 想表达"给这个角色调某个耳目一新的 provider 参数"，写 `options`。

### 8.3 variant：命名变体 = 一组预设的"最高覆盖"

```ts
const variant = model.variants && user.model.variant
  ? model.variants[user.model.variant] : {}
```

模型能声明一组**命名配置**（如不同推理深度），用户/会话用名字选一个（`user.model.variant`），作为 options 合并链的最高层盖上去。**"调参"不止 temperature 一个旋钮——它可以是一整套命名预设。**

### 8.4 model：agent 钉死模型（用于内部站点）

`agent.model = { modelID, providerID }`。主循环实际用**会话选的模型**（user 消息携带）；而 title 生成等内部站是 `ag.model ? getModel(ag.model) : 默认 small 模型`。**Agent 可以既换人设、又换"干这活用哪个模型"，甚至故意用便宜的 small。**

### 8.5 为什么这么设计（工程观）

| 设计 | 动机 |
|---|---|
| 只声明差异，不重述全量 | 配置**可分性**：模型默认是地基，agent 是差异补丁，用户又是再一层补丁——每层只碰自己关心的 |
| 能力表 + `?? undefined` | **知识归属**：哪个模型支持什么，是模型层的事；agent 层不该重复判断 |
| options 逃生舱 | **封闭代码，开放数据**：新参数不意味着加字段/改代码，填进合并链就行 |

> 结论：**"调参"本质是"在默认之上声明差异"，一套 `??` + `mergeDeep` 就表达完所有旋钮。** 这也是"Agent 只是一份配置数据"在参数侧的落点——连"调参"本身都是配置，不是代码。

---

## 九、Prompt 设计原理：从 opencode 的真实 prompt 提炼

opencode 发货了 4 类内部 agent prompt + 1 个"造 agent 的 agent"元提示词。逐类分析后能提炼一套**可迁移的设计原理**（你在 Claude Code 自定义 Agent 时能直接用）。

### 9.1 四种类型，四种写法

| prompt | 角色 & 语气 | 结构 |
|---|---|---|
| **explore**（探索子代理） | "You are a file search specialist"——自信、能力型 | 角色 → 优点 → 工具映射 → 约束 → 收尾指令 |
| **title**（起标题） | 极简："You output ONLY a thread title. Nothing else." | `<task>` + `<rules>` + `<examples>` 三件套 |
| **summary**（写摘要） | 命令式："Write like a PR description" | 一句话 + 规则清单 + 特殊边界 |
| **compaction**（压缩） | 角色 + 强约束 | "Do not continue the conversation" + 严格输出结构 |

### 9.2 提炼出的 8 条设计原理

**① 第一行定角色 + 定边界（scope）。**
```
You are a file search specialist...                  // explore：我是谁
You output ONLY a thread title. Nothing else.        // title：我唯一能输出什么
```
观众扫第一行就知道"它是干嘛的、它不会干嘛"。**边界先立，能力后说。**

**② 把"能力"讲成"工具映射"，而不是抽象描述。**
explore 的 Guidelines 直接把能力翻译成命令：
```
Use Glob for broad file pattern matching
Use Grep for searching file contents with regex
Use Read when you know the specific file path
Use Bash for file operations …
```
**给 agent 的是 executable 的操作手册，不是形容词。** 这也和它的权限联动（explore 的权限就是 Glob/Grep/Read/Bash 这几个工具）。

**③ 写负向约束——"不许"有时比"要"更值钱。**
title 里一连串 NEVER/Do not：
```
Never include tool names in the title
NEVER respond to questions, just generate a title
DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT
Always output something meaningful, even if the input is minimal.
```
探索 prompt 里："Do not create any files, or run bash commands that modify the user's system state in any way." **面向低自主性任务的 prompt，负向清单是护栏。**

**④ 显式输出契约（format contract）。**
```
Your output must be:
- A single line
- ≤50 characters
- No explanations
```
**越是"机器要消费的输出"，越要把格式钉死。** summary/compaction 同理（结构、句数上限）。

**⑤ 用 few-shot 例子而不是形容词规定"什么是好"。**
title 的 `<examples>`：`"debug 500 errors in production" → Debugging production 500 errors`。**"像样例那样"比"高质量、自然、准确"有效得多。**

**⑥ 给"边界输入"留兜底行为。**
title：`If the user message is short or conversational ("hello","lol"…) → create a title that reflects the tone`。**别让 agent 在输入不够时不知所措**——给最差输入也定义行为。

**⑦ 对"内部杂活"类 agent：断链提示。**
compaction：`Do not continue the conversation. Do not respond to any questions... Only output the structured summary`；summary 规定"不解释用户要了什么、第一人称写"。**内部 agent 的输出要被别的 agent 消费——禁止它"越界互动"。**

**⑧ 造 agent 的元提示词（generate.txt）给出了原则清单。**
opencode 自己"指导模型写 agent"时要求：
- `You are...You will...` **第二人称**；
- system prompt = **complete operational manual**（完整操作手册），自治、少靠额外指导；
- 具体大于泛泛（"Be specific rather than generic"）、给例子、内建质量自查；
- identifier：小写连字符 2-4 词、别叫 helper/assistant；
- `whenToUse`：以 "Use this agent when..." 开头、给使用场景例子（还要求例子展示"用 Agent 工具去调它"）。

### 9.3 一把尺子：按"自主性/消费方"决定写法

| 任务类型 | 写法偏向 |
|---|---|
| 高自主（explore / 通用主力） | 能力 + 工具映射 + 方法论，适度信任 |
| 机器消费（title/summary/compaction） | 输出契约 + 负向清单 + 断链，压到最少发散 |
| 换肤即可（build/plan 类角色切换） | 通常不需长 prompt，靠权限矩阵表达"能做什么" |

> 经验总纲（generate.txt 的收尾原话）：**"Your system prompts are their complete operational manual"**——人设不是欢迎词，是让这个 agent 独自干活的《操作手册》。

---

## 十、把这套理论用到 Claude Code 自定义 Agent

你在 Claude Code 的目标——`.claude/agents/<name>.md`，YAML frontmatter（`name` / `description` / `model` / `tools`）+ 正文（system prompt）。概念的映射：

| opencode 的概念 | Claude Code 自定义 Agent |
|---|---|
| `prompt`（人设） | markdown **正文**（§九 的 8 条原理全部适用） |
| `name` / `description` | frontmatter `name` / `description` |
| `model`（钉模型） | frontmatter `model`（可选，不写走全局） |
| `permission` 权限矩阵 | frontmatter `tools`（给这个 agent 开哪几个工具）+ Claude Code 的权限机制（对应 #8） |
| `mode: subagent` | 自定义 agent 都是"可被 Task 工具调的子代理"（正合 subagent 语义） |
| `temperature` / `topP` / `options` | **Claude Code agent frontmatter 默认不暴露**——这部分要回落到模型/全局配置 |

注意两点差距：
1. **调参层面**：Claude Code 的 agent 通常不给 temperature 这类采样旋钮——你主要靠"正文人设"表达差异，调参余地比 opencode 小。
2. **权限层面**：Claude Code 用 `tools:` 白名单 + 权限体系（而非 opencode 的 allow/ask/deny 矩阵）——§ 三种的"默认禁+白名单"思想（exore 模式）正好可平移：**一个只读 agent 就把 tools 限制在 Read/Glob/Grep，不给 Bash/Edit。**

当你真要建时，用这些原理起草正文，具体 frontmatter 字段以 `code.claude.com/docs` 为准（我也可以帮你核对）。**先吃理论，再动手**——正是你现在的节奏。

---

## 十一、思考题（B 步讨论）

1. 为什么说"能力 = 人格 × 权限"？开 title/summary agent 不写新代码这件事，削弱了什么你原来的假设？
2. `defaults` 矩阵里 `.env` 要 `ask`、`question` 要 `deny`——这些"默认例外"反映了什么产品价值观？（安全 vs 顺滑的取舍）
3. `Permission.merge` 让"用户只需写差异"——如果 merge 语义变成"用户配置覆盖一切"，会出什么问题？（提示：内置 plan 的 edit deny 会被覆盖成什么）
4. `explore` 用"`*` deny + 白名单"而 `build` 用"`*` allow + 例外"——**为什么"只读探索型"喜欢默认禁、而"全能主力"喜欢默认开？**
5. `deriveSubagentSessionPermission` 默认禁子代理的 `task`（不能再开子代理）——这是防什么事故？
6. 我们的 harness 现在把 SYSTEM_PROMPT 焊死在 agent-loop 里——把"人格"抽成数据后，agent-loop 需要改哪些？factory/requester 哪些不用变？
7. `temperature ?? 模型默认` 这套"差异覆盖"——为什么比"每个 agent 都必须显式写全温度/topP"更好？写全会带来什么维护问题？（提示：模型升级换默认、多个 agent 重复抄同一组数）
8. title 的这个"每输入都给标题"（连 "hello" 也要给 Greeting）vs 不加会怎样？**"最差输入也定义行为"** 和负向约束，哪个对低自主任务更重要？
9. 如果让你在 Claude Code 建一个"代码审查子代理"（只读不动手）：会用 §9 的哪几条原理写正文？frontmatter 的 `tools` 会白名单哪几个？