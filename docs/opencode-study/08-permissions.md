# 08 · 权限 —— 规则的流水线、双层的闸门、人与机的协议

> 日期：2026-08-24
> 配套源码：`packages/opencode/src/permission/`（`index.ts`：evaluate/fromConfig/merge/disabled/Service，约 220 行核心；`arity.ts`：bash 命令摘要词典）、`packages/core/src/v1/permission.ts`（规则 schema + 错误类型）、`packages/schema/src/v1/permission.ts`（网络协议 schema）、`packages/core/src/permission/`（`saved.ts`/`sql.ts`：已批准权限的持久化，审计用）、测试 `test/permission/next.test.ts`（1175 行，语义的真 source）。
> 工具侧接线：`tool/read.ts`、`tool/edit.ts`、`tool/todo.ts`、`tool/shell.ts`（命令解析→pattern）、`tool/question.ts`、`tool/plan.ts`（plan_exit）；`session/tools.ts`（ctx.ask 构造）、`session/llm/request.ts:208`（resolveTools 请求时过滤）、`session/processor.ts:372`（doom_loop 权限）与 `:186-203`（RejectedError→blocked）、TUI `packages/tui/src/routes/session/index.tsx:335-341`（plan_enter/plan_exit 切 agent）。
> 前置：#3 Agent 管理（permission 字段、merge 语义、subagent 权限边界）、#1 Agent Loop（停止条件——rejected 触发 blocked）、#5 Tools、#12 事件总线（permission.asked/replied 两个事件就是总线上的货）。

## 一句话总结

**权限 = 一条"末条匹配者胜出"的规则流水线 + 一扇"先藏后禁"的双层闸门 + 一套"ask ⟷ reply"的人机协议。权限不是代码而是数据——一个 `{permission, pattern, action}` 有序数组；求值只问"最后一条是谁配上的"，任何 pattern 没人配得上就默认 `ask`（把人设为最终兜底）。执行时先藏后禁：`deny` 掉整工具 → 请求时就把它从模型的可见工具清单里剔除（模型看不见、不会调）；真正执行时 `ctx.ask` 对具体调用再求值——`allow` 放行、`ask` 挂起等人类批、`deny` 抛 DeniedError 把"相关规则"回喂给模型让它改道。人回复 `once`（仅本次）/`always`（沉淀进会话内存态 + 级联放行同会话同款挂起）/`reject`（拒 + 可带话回喂反馈）。**

可以用一句话的**一次工具调用**串起来看：

```
模型想跑 git checkout main
   └─> 请求组装：evaluate(git 工具, "deny *"? ) → 若 git 工具整体 deny = 模型根本看不到这个工具
   └─> 模型看到了、发起了：ctx.ask({ permission:"bash", patterns:["git checkout main"], always:["git *"] })
         └─> evaluate("bash", "git checkout main", ruleset=agent⊕session, approved)
               ├─ 匹配到 deny 规则 → DeniedError（带上相关规则给模型）
               ├─ 匹配到 allow 规则 → 放行，命令直接跑
               └─ 无匹配（默认）→ ask：挂起 + 发 permission.asked 事件，等人类
                     ├─ 人类 "once"       → 放行这一次
                     ├─ 人类 "always"     → approved += { bash, "git *", allow } → 本会话"git 命令"都不再问了；级联放行同会话同类挂起
                     └─ 人类 "reject"+话  → CorrectedError 把话喂回模型
```

---

## 一、规则流水线：一条规则 = permission + pattern + action

### 1.1 最小的数据结构

```ts
// schema/v1/permission.ts:16-25
export const Action = Schema.Literals(["allow", "deny", "ask"])          // 三种处置
export const Rule = Schema.Struct({ permission, pattern, action })       // 一条规则
export const Ruleset = Schema.Array(Rule)                                // 整个权限 = 规则数组
```

三个字段，各管一件事：

| 字段 | 语义 | 例子 |
|---|---|---|
| `permission` | 面向**哪个工具/类别**（支持通配 `mcp_*`） | `bash`、`edit`、`read`、`external_directory`、`doom_loop`、`question`、`task`、`*` |
| `pattern` | 面向这个类别里的**哪个具体对象** | 全局 `*`；文件 glob `src/*`；命令前缀 `git *`；云端资源 `mcp:my-server:*` |
| `action` | 配上了（permission 和 pattern 都匹配）怎么办 | `allow` 放行 / `ask` 问人 / `deny` 禁止 |

**横着看 pattern 有三类，正好对应三类"对象"：**

1. **全局** `*` —— 一刀切整个工具（`bash: allow`）
2. **文件 glob**（edit/read 类）—— `edit { "src/*": allow, "src/secret/*": deny }`
3. **命令前缀**（bash 类）—— `bash { "*": deny, "git *": allow }`（第六条讲它怎么来）

**纵着看 permission 也支持通配**：一条 `mcp_*: allow` 就能覆盖所有 MCP 工具，后端接一个新 MCP 工具不用改权限。这是"权限是数据不是代码"的直接红利——**能力扩张时，规则集自动跟上**。

### 1.2 配置是嵌套对象，运行时展开成规则数组

```ts
// permission/index.ts:186-198 —— fromConfig
export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })       // {bash:"allow"} → 一条全匹配
      continue
    }
    ruleset.push(                                                            // {bash:{"rm":"deny","*":"allow"}} → 逐 pattern 一条
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}
```

注意两点：
- **插入顺序被保留**（测试 `fromConfig - preserves top-level config key order` 钉死）——因为第二条的求值**依赖顺序**。
- `expand()` 专门处理 `~` / `~/...` / `$HOME` —— 配置里写 `external_directory: { "~/projects/*": "allow" }` 会被展开成真实家目录绝对路径。**让用户在配置文件里写能读懂的短写**。

---

## 二、求值引擎：`findLast` 打败 specificity

opencode 的求值只有一行，但地铁最硬核的决定都在这一行里：

```ts
// permission/index.ts:28-38 —— 整个权限系统的核心
export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      action: "ask",        // ← 什么都没匹配上 = ask！
      permission,
      pattern: "*",
    }
  )
}
```

四件事：

### 2.1 多条 ruleset 平铺成一维，一视同仁

`...rulesets` 全部 `flat()` 成一个数组再找。所以"规则来自哪层"（agent / session / runtime approved）**在求值时根本看不出区别**——它们只是被 `merge` 顺序排好的一个列表。顺序 = 优先级。

### 2.2 `findLast`——**末条匹配者胜出**，不是"最具体者胜出"

这是最容易踩的坑（和直觉相反）：

```ts
// 测试证据 next.test.ts:298-304
evaluate("bash", "rm", [
  { bash, pattern: "rm",      action: "deny"  },   // 更具体
  { bash, pattern: "*",       action: "allow" },   // 更宽泛
])
// → "allow"！  因为“*”在后面，它赢了，哪怕 “rm” 更具体
```

**为什么？** 因为"具体度"是 eval 器要做的额外计算；**"谁排在后面"是零成本的**。这直接呼应 #3 课的 `Permission.merge`：用户配置只需写"差异、放最后"，就天然覆盖内置——**配置的可分性（只写补丁不重述）与求值的简单性（findLast）是同一件事的两面**。

> 心智模型：**Ruleset 是一条有序的命令式清单——"第 N 条规则，对 {permission 命中 ∧ pattern 命中} 的对象生效，管你是不是被更早的规则管过"**。它不承诺"最细粒度优先"，它承诺"最后写的说了算"。

### 2.3 默认值 = ask：人永远是最兜底的那个

`?? { action: "ask" }` —— 没有任何规则配得上这个调用时，**默认去问人**。

- 未知工具名 → ask（测试 `evaluate - unknown permission returns ask`）
- 空规则集 → ask（`evaluate - empty ruleset returns ask`）
- 规则都配不上这个路径 → ask（`evaluate - no matching pattern returns ask`）

**权限的哲学抉择：默认不是"放行"也不是"禁止"，而是"请示"**。放行是机器自信地对人类说"不用问你"；禁止是配置显式发出的一票否决；**而"没想清楚"的时候，把决定权交回给最该拍板的人**。

### 2.4 `merge` = 平铺拼接

```ts
// permission/index.ts:200-202
export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}
```

没有去重、没有归一化、没有"智能合并"。**后面的规则数组整体排在前面之后**，天然获得"后写覆盖先写"的语义。干净到极致。

---

## 三、规则从哪里来：五层来源，一条有序清单

一次 `ctx.ask` 里实际喂给 `evaluate` 的 ruleset（`session/tools.ts:87`）：

```ts
ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
```

即 **agent 的权限 + 会话的权限**。而真正的规则源头分五层：

| 层 | 内容 | 例子 |
|---|---|---|
| ① **defaults**（agent.ts:119-136） | 全局安全底线 | `*: allow`、`doom_loop: ask`、`external_directory: ask(白名单 allow)`、`question: deny`、`plan_enter/exit: deny`、`.env 文件 ask` |
| ② **agent 特有**（merge 追加） | 角色的能力边界 | build `question: allow`；plan `edit: deny` 但 `.opencode/plans/*.md allow`；explore `*: deny`+白名单 |
| ③ **user config**（opencode.json `permission` / `OPENCODE_PERMISSION` env） | 用户全局覆盖 | `{ "bash": { "rm *": "deny" } }` |
| ④ **session.permission**（API 写入） | 单会话补丁 | headless `run` 注入 `{question/plan_enter/plan_exit: deny}` |
| ⑤ **runtime approved**（运行期内存，最后方） | 人类点过"always"的沉淀 | `{ bash, "git *", allow }` |

`merge` 的顺序即优先级：**① < ② < ③ < ④**，⑤ 又在 `ask()` 内部以最后一个 ruleset 追加（`evaluate(request.permission, pattern, ruleset, approved)`，index.ts:73）。

所以 opencode 的"权限配置"是**一叠只增不减的补丁**：内置定底线、角色调边界、用户改差异、会话垒补丁、人类运行时再加码。**每一层都只声明自己的差异，靠"排后面"获得覆盖力**——这就是 §2.2 那条 findLast 的价值所在。

> （审计视角）`packages/core/src/permission/saved.ts` + `sql.ts`：`always` 的持久化另有一条 `permission(project_id, action, resource)` 表，按项目存 `add/remove/list`。它是**审计与"下次重启还记得"**的留存通道，而 §五 的 `approved`（内存态）只管本次实例生命周期的"不再问"。

---

## 四、两层闸门：先"藏"，后"禁"

这是整个设计最漂亮的一手。**对"确认不该用"的工具，opencode 不只在执行时拦，而是在请求组装时就从模型面前拿走。**

### 4.1 第一层：请求时"藏"——deny 的工具不进模型视野

```ts
// session/llm/request.ts:208-214 —— resolveTools
function resolveTools(input) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
}
```

```ts
// permission/index.ts:204-214 —— 判断"整个工具是否被禁"
export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]   // 归一：三个改文件工具都听 "edit" 的
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]  // 都听 "read" 的
  return new Set(tools.filter((tool) => {
    const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
    const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
    return rule?.pattern === "*" && rule.action === "deny"   // ← 必须 pattern 是 * 且 deny
  }))
}
```

关键语义，两个小心思：

- **只对 `pattern === "*"` 且 `action === "deny"` 的工具生效**。`bash: deny` → bash 工具直接从模型声明里消失；但 `bash { "*": allow, "rm *": deny }` 这种**局部拒绝**不会藏工具——因为 `rm *` 这个 pattern 配不上 `*`，`disabled` 只认 `*` 这条。
- **归一（normalize）**：写文件的三个工具 `edit/write/apply_patch` 都归到一个 `edit` 权限名下，读 MCP 资源的三个工具都归到 `read`。**模型看到三个工具，权限却只维护一个类**——规则集粒度与工具粒度解耦，改权限的人不用记住所有别名。

**"藏"的价值**：
1. **模型不会被诱导去硬试**——工具都看不见，自然不会发起注定被拒的调用；
2. **省提问**——不用每次 execute 都撞一回 ask；
3. **保护模型上下文**——与其把三次失败的 deny 错误塞进历史，不如不展示。

### 4.2 第二层：执行时"禁"——ctx.ask 对具体调用把关

藏的只管"整体禁/整体开"；**真正精细的闸门在工具执行第一行**。每个涉及权限的工具都先 `ctx.ask(...)` 再干活：

```ts
// tool/read.ts:255-260 —— 读任意文件前先过闸
yield* ctx.ask({
  permission: "read",
  patterns: [path.relative(instance.worktree, filepath)],   // 具体到"这一个相对路径"
  always: ["*"],                                            // 人类点 always → 本会话读全部不再问
  metadata: {},
})
```

```
// tool/edit.ts:102-110 —— 每次编辑带 diff 供人类审核
patterns: [path.relative(instance.worktree, filePath)],
always: ["*"],
metadata: { filepath: filePath, diff },                     // ← 把改动喂给审核者

// tool/todo.ts:24-29 —— todo 清单写入
permission: "todowrite", patterns: ["*"], always: ["*"]
```

**两层分工**：`disabled` 负责"这个工具不该存在"（政策级、整工具级、模型视野级）；`ask` 负责"这次调用合不合规"（用例级、逐次调用级、人类复核级）。**一个管的是"能不能看见"，一个管的是"能不能这么干"**。

---

## 五、执行时门禁：ctx.ask 的三种结局

```ts
// permission/index.ts:67-107 —— Service.ask 的骨架
const ask = Effect.fn("Permission.ask")(function* (input) {
  const { approved, pending } = yield* InstanceState.get(state)
  const { ruleset, ...request } = input
  let needsAsk = false

  for (const pattern of request.patterns) {                             // 每个 pattern 逐个求值
    const rule = evaluate(request.permission, pattern, ruleset, approved)
    if (rule.action === "deny") {
      return yield* new PermissionV1.DeniedError({                        // ① deny → 立刻失败，
        ruleset: ruleset.filter((r) => Wildcard.match(request.permission, r.permission)),  //   带上相关规则
      })
    }
    if (rule.action === "allow") continue                                // ② allow → 放行这一个
    needsAsk = true                                                      // ③ 其他 → 需要问
  }
  if (!needsAsk) return                                                  // 全放行，干净返回

  const id = request.id ?? PermissionV1.ID.ascending()                   // 挂起：登记 + 发事件
  pending.set(id, { info, deferred })
  yield* events.publish(Event.Asked, info)
  return yield* Effect.ensuring(
    Deferred.await(deferred),                                            // 阻塞在这个 Deferred 上，
    Effect.sync(() => pending.delete(id)),                              //   等人类 reply
  )
})
```

三种结局，对应三种"人格"：

### 5.1 匹配 `deny` → `DeniedError`：规则的一票否决

任一 pattern 撞上 deny 规则，`ask` 立刻失败。错误里带上了**相关规则**：

```ts
// core/v1/permission.ts:21-27
export class DeniedError extends ... {
  override get message() {
    return `The user has specified a rule which prevents you from using this specific tool call.
            Here are some of the relevant rules ${JSON.stringify(this.ruleset)}`
  }
}
```

**DeniedError 的 message 会被工具处理器写回模型可见的 tool-result**（§5.4）。模型看到的不是冷冰冰的 "permission denied"，而是"**你违反了这条规则：`bash/rm */deny`**"——它有信息量去改道。错误本身就是一次讲道理。

> 注意顺序：**多 pattern 是"一票否决"**。即使前面的 pattern 是 ask（会触发询问），只要后面有一个 deny，就整体拒绝，连问都不问（测试 `ask - should deny even when an earlier pattern is ask`）。

### 5.2 全匹配 `allow` → 放行，零开销返回

规则明确放行（含 `approved` 里人类点过的 always），`ask` 不阻塞、不提问、不发事件——**机器自信地替你签字**。

### 5.3 无匹配（默认 ask）→ 挂起 + 等人类

这是常态（默认哲学 §2.3）。`ask` 变成一个**异步阻塞点**：
1. 生成 `id`，构造 `Request{ id, sessionID, permission, patterns, metadata, always, tool }`；
2. 写进 `pending` 表 + 发 `permission.asked` 事件（事件总线）；
3. **`Deferred.await` 阻塞**——当前工具调用停在这，直到人类 `reply`。
4. 无论成败，`ensuring` 保证收尾时把这条从 pending 清掉。

**注意 tool-result 里是"当前这个工具调用"卡住，而 agent loop 其他部分照常活着。** 因为 `Deferred` 是 effect 世界里的"一次性信箱"：`reply` 来敲门，`await` 就结束，`ask` 返回 void，工具继续跑。**权限系统的整个交互模型 = 一个分布式的一次性信箱协议**（第七条展开）。

### 5.4 失败如何回喂给模型

`ctx.ask` 用 `Effect.orDie` 把 typed error 变成 defect；工具调度在 processor 里把 tool-error / rejected 记成该 tool-call 的失败结果（`session/processor.ts:186-203`），让模型在下一轮看到：

- `DeniedError.message`（含相关规则）→ 模型知道自己撞了哪条规则，换路；
- `RejectedError` → "人类拒绝了这次调用"（无详情）；
- `CorrectedError.feedback` → 人类拒绝时写了话，原话喂回模型（"请不要删文件，改用…"）。

并且，**有一个值钱的联动**（processor.ts:200-201）：

```ts
if (error instanceof PermissionV1.RejectedError || error instanceof Question.RejectedError) {
  ctx.blocked = ctx.shouldBreak    // ← 连接 #1：用户明确拒绝 → 软性"该停了"
}
```

人类 reject 一个工具调用，不只是这一调用失败——它还**压低 loop 的继续意愿**（`blocked` 成为停止条件的输入之一）。权限拒绝在这里和 Agent Loop 的终止哲学接上了：**用户拒绝 = 系统该收敛了**。

---

## 六、命令摘要：pattern 是"人看得懂的单元"（arity.ts）

bash 的权限是**最难、也最体现功力**的一块。难点：命令千差万别，permission 却要作用在"人能审核的粒度"上。

### 6.1 为什么不能拿原始命令当 pattern？

`rm -rf /` 和 `rm stale.log` 都是"rm 家族"，但危险程度天差地别。如果 pattern 是**整条命令**，那 `rm stale.log` 这条具体命令的 ask 无法覆盖"以后所有 rm"——权限失去推广力；如果 pattern 是**第一个词** `rm`，放行 `rm *` 等于放行 `rm -rf /`——权限失去精确性。**opencode 的解法：把命令抽象到"人类能审核的子命令级别"。**

### 6.2 流程：tree-sitter 解析 → 叶子命令 → arity 摘要

```ts
// tool/shell.ts:263-291 + 392-414
// ① 命令 parse 成 AST，遍历所有 "command" 节点
for (const node of commands(root)) {
  const tokens = command.map((item) => item.text)
  ...
  if (tokens.length && (!cmd || !CWD.has(cmd))) {
    scan.patterns.add(source(node))                                   // pattern = 这条命令的完整原文
    scan.always.add(BashArity.prefix(tokens).join(" ") + " *")        // always = 摘要前缀 + " *"
  }
}
// ② 把整批 patterns 一次性丢给 ctx.ask
yield* ctx.ask({ permission: ShellID.ToolID, patterns: [...], always: [...], metadata: { command } })
```

- **pattern**（要被求值的）＝ 叶子命令的完整原文：`rm -rf /`、`git checkout main`、`npm run dev`。`evaluate("bash", "git checkout main", ["git *": allow, ...])` 用 glob 判断。
- **always**（人类点 always 时沉淀进 `approved` 的）＝ **BashArity 摘要 + ` *`**：`git *`、`npm run dev *`、`rm *`。

**于是"本次 ask 是具体的（就这一条命令），always 是类别的（这一类命令）"。** 用户给 `git checkout main` 点了 always，`approved` 里落的是 `{ bash, "git *", allow }`，从此这个会话里任何 git 子命令都不再问——但 `rm` 想骗个 always？它沉淀的是 `rm *`，而 `rm *` 这条规则在 defaults 里早被写死成更重要的东西…… 这是权限的"类目化"表达能力。

### 6.3 arity：一条"命令摘要词典"

```ts
// permission/arity.ts:1-9
export function prefix(tokens: string[]) {
  for (let len = tokens.length; len > 0; len--) {
    const prefix = tokens.slice(0, len).join(" ")
    const arity = ARITY[prefix]                      // 查词典：git → 2
    if (arity !== undefined) return tokens.slice(0, arity)
  }
  if (tokens.length === 0) return []
  return tokens.slice(0, 1)                          // 未知命令默认取第一个词
}
```

词典（arity.ts:24-161）给常用命令族标了"摘要要取几段"：

| 命令 | arity | 摘要 | 例 |
|---|---|---|---|
| `rm -rf /` | 1 | `rm` | 裸命令 |
| `git checkout main` | 2 | `git checkout` | `git` 家族 arity 2 |
| `npm run dev --port 3000` | 3 | `npm run dev` | `npm run` 更细一个层级 |
| `docker compose up -d` | 3 | `docker compose up` | 最长前缀胜出 |
| `unknown cmd x y` | 1 | `unknown` | 词典没有 → 取首词 |

**规则：flags 不算（只有 subcommand 计）；最长匹配前缀胜出；只有与短前缀语义不同的才收录长前缀**（`git` 已是 2，就不会再列 `git checkout`，除非它该是 3）。这份词典是用 prompt 生成的（文件头注释里有），有意覆盖全栈常见命令。

> 核心思想再强调一次：**权限不是作用在字符串上，是作用在"人对命令行的人类语义单元"上**。`git checkout main` 会被抽象成"但我允许你跑 git checkout 这一类操作"的最小单元 `git *`，恰到好处。

---

## 七、一方提问，一方作答：ask/reply 状态机

这是权限系统的"交互面"。涉及三个运行时概念：`pending`（挂起表）、`deferred`（一次性信箱）、`approved`（会话级已批规则）。

### 7.1 Request：提问者递上的"案卷"

```ts
// schema/v1/permission.ts:27-35
export const Request = Schema.Struct({
  id, sessionID,
  permission: String,
  patterns: Array(String),        // 本次要逐条求值的具体对象
  metadata: Record<String,Unknown>,  // 给审核者看的话（命令原文/diff/目标路径）
  always: Array(String),          // 人类选 always 时代入 approved 的"类别"
  tool?: { messageID, callID },   // 关联到具体那次模型 tool-call，方便 UI 定位
})
```

`metadata` 是给人看的。read 带文件路径、edit 带 `diff`、bash 带 `command` 原文、external_directory 带目录列表——**提问时把人需要的判断材料一次给全**。

### 7.2 reply：三种答复

```ts
// schema/v1/permission.ts:38-39
export const Reply = Schema.Literals(["once", "always", "reject"])   // 可带可选 message
```

| 答复 | 行为 | 后续效果 |
|---|---|---|
| `once` | 解阻塞这一个 Deferred，放行本次调用 | 无持久化 |
| `always` | 解阻塞 + **把 `always` patterns 沉淀成 `approved` allow 规则** | 本次会话同类不再问 + 级联放行同会话同类挂起 |
| `reject`（可选 message） | `Deferred.fail`：无 message→RejectedError；有 message→CorrectedError | **级联拒绝同会话所有挂起** |

**两个级联是被测试钉死的行为**：

**always 级联**（reply 处理末尾，index.ts:153-166）：给 A 点 always 后，遍历同会话所有 pending，谁的 patterns 在更新后的 `approved` 下全部 allow，就**代答 always 一并放行**——"你既然允许了这类，同类排队的一起过"（测试 `reply - always resolves matching pending requests in same session`）。跨会话不级联（`reply - always keeps other session pending`）。

**reject 级联**（index.ts:129-139）：给 A 点 reject，**同会话所有 pending 全部 fail(RejectedError)**——"这一个你拒了，同批别的也别问了"（测试 `reply - reject cancels all pending for same session`）。就像人在拒绝一个危险操作时，顺手拂掉整桌的待审批。

### 7.3 approved：会话级"免检名单"

```ts
// index.ts:23-26
interface State {
  pending: Map<ID, PendingEntry>     // 挂起表：id → { 案卷, 信箱 }
  approved: PermissionV1.Rule[]      // 已批规则：人类点 always 沉淀的 allow
}
```

- **作用域**：`InstanceState` —— 即 **per-instance（每目录一份）**，测试 `permission requests stay isolated by directory` 钉死：两个目录的审批互不相干。
- **寿命**：实例内存生命周期。UI 文案直白："This will allow ... until OpenCode is restarted."（permission.shared.ts:128）。**instance 重载/销毁 → 所有 pending 一律 RejectedError**（测试 `pending permission rejects on instance reload/dispose`）——人不在了，挂起作废，绝不悬空。

### 7.4 事件化：权限请求是总线上的货

`Schema 层定义了 permission.asked / permission.replied 两个事件（schema/v1/permission.ts:61-66）`，通过 `EventV2Bridge`（#12 事件总线）发布。于是**提问/答复是"可观察状态"而不是藏在 service 里的内部细节**：CLI 的 UI 订阅 `permission.asked` 渲染弹窗、Server API 暴露 `permission.list()`/`permission.reply()`、ACP 也能驱动同一套协议（`cli/.../stream.transport.ts` 从 SDK `permission.list` 拉取渲染）。**Permission.Service 是"交易核心"，而问-答的每一环都事件化，供外面的世界看到和驱动。**

> 至此，第四/五/六/七节拼成完整闭环：**政策进 ruleset（配置）→ 执行时 ask 求值（代码）→ 需要时挂起发事件（协议）→ 人类 reply 决策（UI/API）→ 结果沉淀或回喂（approved / Error）→ 下一轮 ask 自然用上**.权限不是"if-else"，是一套可观测、可审计、可被任何端驱动的状态机。

---

## 八、策略层的几个特别开关

### 8.1 无人在环时的"策略退行"：headless run 注入 deny

```ts
// cli/cmd/run.ts:430-448
const rules: Ruleset = interactive ? [] : [
  { permission: "question",  action: "deny", pattern: "*" },
  { permission: "plan_enter", action: "deny", pattern: "*" },
  { permission: "plan_exit",  action: "deny", pattern: "*" },
]
```

非交互跑（`opencode run "..."`，没有 TTY）时，把三个"会话型的互动工具"整体 deny，作为 **session.permission** 叠加进去。**没有人在键盘后面等着回答时，绝不开放会阻塞等待的交互通道**——这是权限系统对"执行环境不确定"的自我保护。

### 8.2 doom_loop：复读机也要请示

```ts
// session/processor.ts:372-379
yield* permission.ask({
  permission: "doom_loop",
  patterns: [value.name],
  ...
  always: [value.name],
  ruleset: agent.permission,
})
```

#1 课的"连续失败后是否继续"在这里也是权限类目——**当 agent 要在失败后硬撑下去时，同样过一道人类的闸**。权限系统不只有工具权限，它覆盖"agent 行为的危险拐点"。

### 8.3 question / plan 靠"藏"而非"gate"

`question` 工具（tool/question.ts）和 `plan_exit` 工具内部**根本不调 `ctx.ask`**——它们自己是"问人的工具"。那 `defaults: question: deny` 怎么生效？**靠 §4.1 的 `disabled`**：`question` 被 deny → 工具直接从模型可见清单消失，模型（默认 agent）根本不会发起提问工具。想开的人（build/plan agent）显式 `question: allow`。**"禁止交互类工具"= 把它藏起来，而不是等它执行时拦。**

---

## 九、模式切换：plan_enter / plan_exit 的"能力换乘"

#3 课说"能力 = 人格 × 权限"。**模式切换把这个公式变成了流程**：

### 9.1 plan agent = 一张王牌权限矩阵

```ts
// agent.ts:119-136 (defaults) + 160-181 (plan agent 覆盖)
defaults: { "*": allow, question: deny, plan_enter: deny, plan_exit: deny, bash 部分 ask ... }
plan   → merge(defaults, {
            question: "allow",              // 最多提问（它要靠问澄清需求）
            plan_exit: "allow",             // 唯一"正门"出口：请求切回 build
            edit: { "*": "deny", ".opencode/plans/*.md": "allow" },   // 不许改任何代码，只许写计划
            ... }),
```

plan 模式 = **失去编辑能力（edit 全 deny，只留计划文件）、获得提问与换乘能力（question/plan_exit）**。模型看到 `edit` 工具因为 `*`+deny 被 `disabled` 藏掉——它想不起来改代码，只能读读看看写写计划（§四的两层闸门在这里漂亮地配合）。

> 注：`plan_enter` 在 opencode 当前源码里**没有注册成独立工具**（`tool/` 目录只有 `plan_exit`）——它是权限矩阵里的一个键（defaults deny / plan agent allow / headless 注入 deny），TUI 端监听名为 `plan_enter` 的工具 part 完成来切 agent（index.tsx:338）。它更像"进入计划模式的权限标记 + 兼容字段"，真正常走的换乘出口是 `plan_exit` 工具本身。

### 9.2 plan_exit：一次有剧本的工具调用

```ts
// tool/plan.ts:25-76 —— plan_exit 执行体（骨架）
execute: (_, ctx) => Effect.gen(function* () {
  const answers = yield* question.ask({
    sessionID: ctx.sessionID,
    questions: [{ question: `Plan at ${plan} is complete.
       Would you like to switch to the build agent and start implementing?`,
       options: [Yes / No] }],
  })
  if (answers[0]?.[0] === "No") yield* new Question.RejectedError()   // 人说不 → 终止

  // 人在“是” → 注入一条 agent:"build" 的合成用户消息
  const msg: SessionV1.User = { id, sessionID, role:"user", agent:"build", model }
  yield* session.updateMessage(msg)
  yield* session.updatePart({ ..., type:"text",
    text: `The plan at ${plan} has been approved, you can now edit files. Execute the plan` })
  return { title:"Switching to build agent", output:"User approved switching to build agent..." }
})
```

plan_exit 不直接"切换"——它**问人，然后在会话历史里注入一条 `role:user, agent:"build"` 的合成消息**。下一轮 loop 读到这条 user 消息，`agents.get("build")` 一换，模型的正下方整个工具集和人格就变了。

> **模式切换 = 编辑会话状态里的 `agent` 字段**。没有全局 mode 标志、没有分支代码，就是"再喂一条 user 消息"。这再次验证 #3/#2 的"一切皆配置数据"。

### 9.3 TUI 端监听

```ts
// packages/tui/src/routes/session/index.tsx:335-341
if (part.tool === "plan_exit")  { local.agent.set("build"); lastSwitch = part.id }
else if (part.tool === "plan_enter") { local.agent.set("plan");  lastSwitch = part.id }
```

TUI 看到 `plan_exit` 工具的 part 完成，就把本地 agent 状态切到 build（`plan_enter` 同理切到 plan）。**UI 的"当前模式"来自回放工具调用流，而不是独立维护一个状态**——单一事实源仍在那条消息流里。

---

## 十、子代理与权限：别让子代理变成越权代理人

（承接 #3 课 §五，这里补上 task 工具内部的两处权限协作）

### 10.1 模型能 spawn 谁，是权限过滤过的清单

```ts
// tool/registry.ts:266-277 —— describeTask
const filtered = items.filter(
  (item) => Permission.evaluate("task", item.name, agent.permission).action !== "deny",
)
// 拼进 task 工具的 description：只列出当前 agent 允许 spawn 的子代理
```

`task` 工具的描述里**只出现 `evaluate("task", <agentName>, 当前agent.permission) != deny` 的子代理**。即：你能派谁，取决于你的权限矩阵里有没有 `task/{agentName}` 的放行。**子代理名录本身就是权限输出**——模型不可能 spawn 一个"不该知道存在"的代理。

### 10.2 子会话权限合成：只收敛，不放大

#3 课讲过的 `deriveSubagentSessionPermission`：父的 deny + external_directory 下传、子代理按自带 permission 定能力、默认禁 chain spawn（task/todowrite）。

这里是**权限收敛的铁律下传**：**子代理拿到的 ruleset 永不完全继承父的 allow，只继承约束（deny）。**能力向下收敛、风险不允许放大——这是"子代理是受限执行者"在权限层的实现。

---

## 十一、对照 Claude Code（经 claude-code-guide 按 2026-08 官方文档逐条核实）

Claude Code 的权限体系与 opencode 是**同构异形**——同一场"人机权限谈判"，两套不同的形式化。这张对照表是**已核对**的，不是凭印象写的。

### 11.1 映射表

| 维度 | opencode | Claude Code |
|---|---|---|
| 规则数据 | `{permission,pattern,action}` 数组 | `settings.json` 的 `permissions.allow/deny` 数组 + PreToolUse hook |
| 规则语法 | `{ bash, "git *", allow }`（工具名下带 glob pattern） | `"Bash(npm run test:*)"`、`"Edit(*)"`、`"Read(~/secret/*)"`、`"mcp__<server>__<tool>"`；路径用 gitignore glob（`*` 单段、`**` 递归） |
| 多规则优先级 | **末条匹配者胜出**（order 决定，findLast） | **deny > ask > allow**，**首个匹配即定局**（与粗细无关，宽 deny 压窄 allow） |
| 默认姿态 | **ask**（无规则即问人） | **ask**（默认模式只放行只读，其余每次问） |
| 模式即"一档子规则集" | agent 的 permission 矩阵（build/plan/explore…） | **permission modes**：`default/manual`、`acceptEdits`、`plan`、`bypassPermissions`（另加 `auto` classifier 审查、`dontAsk` CI 用） |
| 一键放行本次 | reply `once` | 弹窗 `Yes`（Y/Enter） |
| "会话级"放行 | reply `always`（approved **内存态，instance 重启即清**） | 分工具：**Edit/Write 的 "always" 只到会话结束（不落盘）**；Bash 命令/WebFetch/WebSearch 的 "always" **per-仓库永久**，写入 `.claude/settings.local.json`，对未来会话生效 |
| 工具整体禁 | `disabled`：`*`+deny → 从模型工具清单剔除 | 裸工具名 deny（`"Bash"`）或工具级 glob（`"*"`、`"mcp__*"`）→ 工具从 Claude 上下文移除；scoped deny（`"Bash(rm *)"`）保留工具只挡命中的调用 |
| 编辑确认 | edit 工具带 diff 的 ctx.ask | `acceptEdits` 模式下编辑自动过；`default/manual` 下编辑每次同意；Edit 的路径规则存在但 Write/MultiEdit 路径规则不生效（只警告） |
| 计划模式 | plan agent = 编辑 deny 矩阵 + question/plan_exit | `plan` mode = 只读探索、编辑被阻断直到批准计划，用 `ExitPlanMode` 呈现 |
| 可编程审核端 | Permission.Service（ask/reply/list）+ 事件 `permission.asked/replied` | PreToolUse hook 的 `permissionDecision`（allow/deny/ask/defer）+ `PermissionRequest` 事件→decision 对象（behavior/updatedPermissions…） |
| 组织级强制 | `packages/core/permission/saved.ts`（数据库审计表） | managed-settings.json 的 `permissions.deny` + `disableBypassPermissionsMode` + `allowManagedPermissionRulesOnly`（仅 managed 规则生效） |
| "拒绝时带话" | reply `reject + message` → `CorrectedError.feedback` 回喂模型 | 弹窗评注（Tab 开注释）+ PreToolUse `"deny"` 配 `permissionDecisionReason` 回喂 Claude |

### 11.2 必须记住的四处"并不像"（对照时最容易写错）

1. **优先级方向相反**：opencode 是"末条胜出、谁排后谁赢"；**Claude Code 是 `deny > ask > allow`、首个匹配定局**。同一条 `deny` 在 opencode 里可以被排在后面的 allow 覆盖，在 Claude Code 里任何 allow 都压不过。这是两套哲学最硬的分歧——opencode 用"顺序"表达层次与覆盖，Claude Code 用"显式优先级"表达铁律。

2. **"always"的存活范围不一致**：opencode 的 always **统一的会话内存态**（`approved`，重启即清）；Claude Code **分工具**——编辑类的 always 只到会话（内存），Bash 类的 always 是**持久化规则**（写 `.claude/settings.local.json`，跨会话）。B 步可以讨论：哪种更合理？

3. **`!` 不是权限应答**：Claude Code 里 `!` 是**输入框开头的 shell 模式前缀**（用户直接执行命令、绕过"让 Claude 去跑"这层），它不是权限弹窗的强制允许键。曾有人记成"弹窗里按 `!` = 永久放行"，是错的。

4. **`allowOnce` / `allowAlways` 是弹窗交互选项，不是 hook 返回值**。hook 只能表态 4 个值：`allow`（跳过弹窗，但 **deny/ask 规则仍生效、压不过**）、`deny`（取消调用 + reason 回喂）、`ask`（照常弹窗）、`defer`（非交互下暂停待续）。**hooks 只能收紧、不能放松**——PreToolUse allow 压不过 ask/deny 规则，而 PreToolUse deny 在任何模式（含 bypassPermissions）都生效。

> （顺带）CLI 对应物：`--permission-mode`、`--allowedTools` / `--disallowedTools`（裸工具名会从上下文移除）、`--dangerously-skip-permissions`（= bypassPermissions 启动）；**`--security-model` 已废弃移除**，别按旧笔记写。

---

## 十二、对照我们的 harness（为 D 步铺路）

### 12.1 现状

harness 目前权限只有"工具白名单"一档：

| 维度 | opencode | harness 现状 | D 步可做 |
|---|---|---|---|
| 规则数据 | allow/ask/deny 矩阵 | 无——只有 `Agent.tools` 白名单（`tool/registry.ts:66-75` 的 `toolsFor`） | 引入 `Rule/Ruleset` + `evaluate` |
| 求值 | `findLast` + 默认 ask | 白名单 = "在/不在" | `evaluate()`：末条匹配 + `?? ask` |
| 执行门 | 每个工具 `ctx.ask` | `registry.execute` 直接跑（`registry.ts:81-98`） | execute 前插 `ask` 闸：allow/deny/ask 三结局 |
| 交互 | pending + Deferred + reply(once/always/reject) | 无（CLI `repl.ts` 全自动跑工具） | CLI 挂起式提问 + 键盘 1/2/3 应答 |
| 藏工具 | `disabled` 从模型声明剔除 | `toolsFor` 已是"按 agent 裁剪"（接近但凭白名单非 deny） | `disabled()`：`*`+deny 的整工具剔除 |
| session 权限 | session.permission 补丁 | 无 | build 默认 + plan 的 edit deny 靠矩阵表达 |
| approved | 会话级 always 沉淀 + 级联 | 无 | 先不做级联，做"once/always"两档 |

### 12.2 D 步最小落地（建议）

1. **数据层**：`tool/` 或新 `permission/` 下加 `Rule{permission,pattern,action}` + `evaluate()` + `fromConfig()≈可用 tab 写死`；
2. **钩子点**：`ToolRegistry.execute()`（`registry.ts:81`）在跑 execute 前插入 `ask(permission, pattern)` → `allow` 直接过 / `deny` 返回"被规则拒绝+相关规则"给模型 / `ask` 走 CLI 交互；
3. **交互**：`cli/repl.ts` 在 ask 时 `Readline` 提问渲染 `on/always/reject`，把决定带回；
4. **演示**：plan agent 从"白名单不出 write_file"（现状）升级成"矩阵表达 `edit deny`"，build 加一条 `bash rm* deny` 演示 deny→模型改道。让 `denied` 工具的"藏"在请求时生效（`toolsFor` 接 `disabled`）。

D 步不需要 10.2 子代理收敛（#4 待做）、不需要 saved 持久化（#13）、不需要 event 总线级联（#12 简化版够了）。

---

## 十三、为什么这么设计（工程观）

1. **权限是数据，不是代码**：新增工具不碰权限系统；新增 MCP 靠 `mcp_*` 通配自动纳入；配置可审计可导出。**"能力扩张"不追责到代码改动。**
2. **`findLast` 而非"最具体胜出"**：零转换成本的"配置覆盖"——"我想再补一条" === "我再 push 一条"。组合性（merge）和简单性（findLast）是同一件事。
3. **ask 是默认，deny 是一票否决**：务必记住 opencode 的意识形态——**安全和顺滑之间，人永远拥有最后一道闸**。`?? ask` 意味着"规则没想到的场景"也不会裸奔,而是回到人。
4. **先藏后禁双层**：藏 = 政策（看不见就不打扰）、禁 = 用例（真要干就受审）。单层做不到：只藏太粗（局部 deny 会漏）、只禁太吵（每次撞墙）。
5. **命令语义化（arity）**：权限作用在"人看得懂的单元"，让"放行一类命令"成为可能。**抽象层次 = 审核质量。**
6. **once/always 双档 + 级联**：once 零负担、always 一次授权多处收益（级联），**在"少打扰"和"不放大风险"之间找平衡**——approved 只活在一个 instance 生命周期，重启即清零。
7. **事件化（asked/replied）**：权限请求是**可观测状态**而非内部细节——CLI/Server/ACP 都能驱动同一协议，问答双方因此彻底解耦。
8. **reject 的 soft 阻断**：权限拒绝不仅失败一次调用，还压低 loop 的继续意愿（blocked）——**权限系统是 Agent Loop 的"刹车踏板"**。

> 一句话收束：**opencode 把"人机之间的权限谈判"做成了一条可组合的数据管线（规则）、一扇双层的闸门（藏+禁）、和一套可观测的协议（ask/reply）——让安全成为架构的一部分，而不是散落的 if。**

---

## 十四、思考题（B 步讨论）

1. 为什么 `evaluate` 用"末条匹配胜出"而不是"最具体胜出"？假设改成"最具体优先"，`Permission.merge` 的"用户写差异就覆盖"还成立吗？试着设计一个反例。
2. `?? ask` 的默认兜底，和"默认 deny 然后只开白名单"（explore 那种）各自的利弊？什么时候你会选后者？（提示：乐观 vs 悲观授权、任务性质的自主度）
3. `disabled()` 只在 `pattern === "*" && deny` 时藏工具——为什么局部 deny（如 `rm *`）不藏？如果藏了会有什么副作用？（提示：模型会怎么猜"我在哪一步被藏了"）
4. bash 的"ask 是这条命令、always 是这类命令"——`git checkout main` 点 always 沉淀 `git *`。这把"精确一次"和"推广到类"的杠杆放在哪？它是否是合理的产品取舍？如果 always 也存整条命令会怎样？
5. reject 级联（同会话全拒）和 always 级联（同会话同类全放）——两个级联都是为"人只会点一次"设计的。你认同吗？级联会不会误伤？（提示：一个会话里并行两个工具时）
6. `DeniedError` 的 message 把相关规则 JSON 塞给模型，让模型"讲道理地改道"。如果只返回 "permission denied"，模型会怎么表现？这个设计如何让失败成为一种指导？
7. plan_exit 注入 `role:user, agent:"build"` 的合成消息来切模式——为什么不用全局状态标记"当前模式"？"单一事实源仍在消息流"这个选择带来什么好处/坏处？
8. headless run 注入 deny（question/plan_enter/plan_exit）——还有什么工具/权限是"无人在环"时必然要 deny 的？我们的 harness 的 `run`（如果将来加非交互模式）需要劫守哪些？
9. 对照表（§十一）在 Claude Code 里，`always` 等效于哪个交互？它的记忆要不要"重启即清"？（B 步核对后讨论）
10. harness 现状是"白名单流"（`Agent.tools` 在/不在）直接演进出 `disabled()` 藏工具；它的 `execute()` 要插 ask 闸，你会把 `ask` 放在 `ToolRegistry.execute` 里、还是每个工具内部（像 opencode 那样）？各有什么代价？