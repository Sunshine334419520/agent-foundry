# Agent Harness 领域核心概念（来源：知乎专栏，用户手动整理）

> 来源：https://zhuanlan.zhihu.com/p/2054530394293380836
> 本文整理了当前 Agent Harness 领域的核心概念与一线框架的新特性，从最底层的 Agent Loop 一直讲到自我进化的记忆系统。内容会随框架迭代和新特性出现持续更新
> 最新更新日期：2026 年 6 月 28 日
> 定位：学习地图之外的前沿概念索引。逐项深入时以官方源码/文档为准。

## 内容提纲

- 为什么要谈 Harness：Prompt、Context、Harness 三个时代的演进
- Agent Loop：所有 Harness 框架共享的 ReAct 内核
- 常见 Harness 框架横向对比：Claude Code、Codex、OpenClaw、Hermes、OpenHuman
- Loop Engineering：人从写 Prompt 转向定义状态和循环
- Harness 的核心抽象层：Tool Call、MCP、Skill、SubAgent、Memory、Hook、Plugin、Goal 八种抽象
- Skill 的实现原理
- SubAgent 的实现原理
- 前沿特性速览：Agent Team、Goal、Humanize、Dynamic Workflows、Auto Dream、OpenHuman 记忆系统、Hermes 自我进化

## Harness 时代

过去几年，业界对大模型的关注点经历了三次转移，可以用三个词概括：Prompt、Context、Harness。

| 阶段 | 时间 | 问题 | 一句话 |
|---|---|---|---|
| Prompt Engineering | 2020 至 2024 | 模型还不够听话，怎么让它按指定格式输出 | 控制模型输出什么 |
| Context Engineering | 2024 至今 | 模型的上下文学习和多轮能力变强，怎么组织上下文、补充知识 | 控制模型看什么 |
| Harness Engineering | 2026 至今 | 模型本身已具备强多轮能力，怎么搭一个约束模型行为、组织模型能力的环境 | 控制模型生产什么 |

Prompt 时代解决的是单次输出的可控性，Context 时代解决的是知识注入，而 Harness 时代解决的是行为约束与能力编排。模型越强，外层环境的设计就越重要，因为强模型需要是一个能让它自由发挥又不脱轨的运行框架。

## Agent Loop：所有 Harness 的核心

现今所有 Harness 框架的核心都是同一个 Loop，也就是 ReAct 范式：模型思考，调用工具，拿回结果，再思考，直到任务完成。所有其他设施都是围绕这个 Loop 搭建的，包括 Skill、Memory、SubAgent 等。

围绕 Loop 的三类基础设施：
- 消息平台：负责承载对话，可以是独立 App、CLI，也可以是开放接口
- 内置工具：读写文件、跑命令等原子能力
- 记忆系统：跨会话保存偏好、经验和失败教训

Skill 和 SubAgent 则建在这套基础之上，作为更高层的能力封装。理解一个 Harness 框架，本质上就是理解它如何组织这个 Loop 的上下文，以及它在 Loop 周围挂了哪些设施。

参考：Dive into Claude Code: The Design Space of Today's and Future AI Agent Systems, https://arxiv.org/abs/2604.14228

## 常见 Harness 框架横向对比

目前一线的 Harness 框架可以分为两类定位：一类是生产级、主要面向编程场景的，另一类是 Feature 多但 Bug 也多、面向个人助手场景的。

| 维度 | Claude Code | Codex | OpenClaw | Hermes | OpenHuman |
|---|---|---|---|---|---|
| 开源 | 否 | 是 | 是 | 是 | 是 |
| GitStars | 暂无 | 92.6k | 370k | 60k | 27k |
| 编程语言 | TypeScript | Rust | TypeScript | Python | Rust + TS |
| 代码行数 | 512k | 731k | 2,362k | 261k | 806k |
| 消息平台 | 独立 App / CLI | 独立 App / CLI | 开放 | 开放 | 开放 |
| 内置工具数 | 15 至 20 | 25 | 33 | 34 | 190 |
| 记忆系统 | 轻量 | Auto Memory | 暂无 | MEMORY.md | Markdown + SQLite，26k 行，层次化加向量，极复杂 |
| 自我改进 | Auto Dream | 无 | dreaming 自动整理记忆 | fork 自我复盘写 Skill | Subconscious 循环 |

值得注意的趋势：
- 代码行数和工具数量整体在膨胀。OpenHuman 的 190 个内置工具和 26k 行记忆系统代表了功能堆叠路线的极端
- 几乎每个框架都在做某种形式的自我改进，名字各异，但思路一致：让 Agent 在跑完任务后回头整理自己的记忆或能力
- 生产级框架（Claude Code、Codex）倾向克制，工具数和记忆系统都偏轻量，稳定性优先。个人助手场景的框架则倾向激进堆功能

## Loop Engineering：人只定义状态

Loop Engineering 是一个建在 Harness 之上的概念。它的核心主张是：人不再关注 Agent 具体怎么运行，只负责定义状态。

具体来说，人定义三样东西：任务、验证环境、验收标准。当 Agent 无法达到验收标准时，会有一个外层脚本不断调用 Agent，持续执行任务，直到达标。换句话说，人写的不再是 Prompt，而是 Loop 本身。

这个理念在 2026 年 6 月被两位一线人物先后点破。Claude Code 负责人 Boris Cherny 在公开演讲中表达的意思是，他已经不再直接给模型写 Prompt，而是运行循环，由循环来给模型写 Prompt、决定下一步做什么，他的工作是写循环。OpenClaw 作者 Peter Steinberger（已加入 OpenAI）也发推表达了同样的观点。

Loop Engineering 把人的角色从指令的发出者，变成了状态机的设计者。后文的 Goal、Humanize、Dynamic Workflows 都可以看作这个理念的具体落地。

## Harness 的核心抽象层

理解 Harness 的关键，是搞清楚它提供了哪些抽象，以及这些抽象各自解决什么问题、由谁触发、占不占主上下文、活多久。当前主流的八种抽象：

| 抽象 | 一句话定义 | 解决什么 | 谁触发 / 谁定义 | 上下文 | 持久性 | 层级 |
|---|---|---|---|---|---|---|
| Tool Call | Agent 调一个函数并拿回结果 | 读写文件、跑命令等原子操作 | 模型决定调，harness 执行 | 占用主上下文 | 单次调用 | 最底层原子能力，其余能力最终都落到 tool call |
| MCP | 一套接入外部工具和数据源的协议 | 统一外部服务接口 | 外部 server 提供，模型当 tool 调 | 工具结果进主上下文 | 配置级 | Tool Call 的外部供给来源 |
| Skill | 把可复用工作流封装成含文本与工具说明书的包 | 固化重复流程 | 模型按需加载和调用 | 加载时才进上下文，渐进披露 | 跨会话长期 | 建在 tool call 之上的能力封装 |
| SubAgent | 在独立上下文里调一个独立 Agent | 上下文隔离，并行化 | 主 Agent 调用 | 独立上下文 | 任务级 | 作为 tool 调用 |
| Memory | 跨会话保存偏好、经验、失败教训 | 不用每次重新解释背景 | harness 自动写，启动时注入 | 启动时注入主上下文 | 跨会话长期 | 持久化层 |
| Hook | 在固定生命周期点触发的确定性脚本 | 用代码强制约束行为 | 事件触发，非模型决定 | 通常不进上下文，外部执行 | 配置级常驻 | 凌驾于模型之上 |
| Plugin | 把 Skill、Hook、SubAgent、MCP 打包分发 | 一整套能力 | 用户安装注册 | 取决于内含组件 | 配置级 | 打包分发层 |
| Goal / Plan | 把完成条件变成持久状态，让 Agent 长程无人值守推进 | 跨越几十上百轮、断线重连仍朝目标收敛 | 用户设目标，Agent 自驱循环 | 计划状态持久存储，每轮读取 | 目标级长期 | 凌驾于模型之上，每轮注入上下文 |

读这张表有三个角度：
1. 上下文成本：Tool Call 和 MCP 的结果直接进主上下文，调多了会撑爆窗口；Skill 用渐进披露，只在被调用时才加载；SubAgent 干脆开一个独立上下文，把无关上下文隔离在外
2. 谁说了算：Tool Call、MCP、Skill、SubAgent 都是模型自己决定要不要用；Hook 和 Goal 则不是，它们由事件或外层脚本触发，凌驾于模型之上，模型无法绕过。这正是 Loop Engineering 的抓手所在
3. 活多久：Tool Call 是单次的，SubAgent 是任务级的，Skill 和 Memory 是跨会话长期的，Goal 是目标级长期的。越往下越接近持久状态，越能支撑长程无人值守的运行

## Skill 的实现原理

Skill 听起来高级，源码层面其实很朴素。

格式约定：Skill 必须放在特定位置，例如 `.agents/skills/***/SKILL.md`。SKILL.md 顶部需要一段 YAML frontmatter，写明这个 Skill 的描述和触发条件。

运行机制分两步：
1. 每次对话开始时，Harness 程序扫描所有 Skill，把每个 Skill 的名称和描述组织成一份列表，放在 System Prompt 的最后
2. 对话进行中，当 Agent 判断需要某个 Skill，就去读对应位置的 SKILL.md。这一步是渐进式加载，正文只有在真正需要时才进上下文

一个直接的工程约束由此而来：Skill 不能太多。因为所有 Skill 的名称和描述都常驻在 System Prompt 里，Skill 一多，System Prompt 就会膨胀甚至爆掉。这也是为什么后文 Hermes 要专门做 Skill 的后台合并与归档。

## SubAgent 的实现原理

SubAgent 指在自己的独立上下文窗口中运行的 Agent，它有自定义的系统提示、特定的工具访问权限和独立的权限边界。

什么时候用：当一个辅助任务会用搜索结果、日志或大段文件内容塞满主对话，而你之后不会再引用这些中间内容时，就该把它丢进 SubAgent。主 Agent 只拿回最终结论，中间噪音留在 SubAgent 的上下文里，跟着任务一起结束。

三个可控特性：
- 可以指定 SubAgent 用其他模型，比如让便宜的小模型干粗活
- 可以控制 SubAgent 能用哪些工具，收窄它的权限面
- 可以控制它是否继承主上下文

SubAgent 的本质价值是上下文隔离加并行化。它在主 Agent 眼里就是一次 tool call，调用完返回一个结果，但背后是一整段独立的推理过程。

调用 SubAgent 有两种方式，行为上略有差别：fork 继承完整的对话历史，命名 subagent 则拿一份只带你传入提示的新鲜上下文。

## 前沿特性速览

### Agent Team：多实例自由通信
多个独立的 Agent 实例像团队一样并行协作，关键在于 SubAgent 之间可以自由通信，而不只是各自向主 Agent 汇报。这种横向通信提升了探索的自由度。

Subagent 只向主 Agent 汇报结果，由主 Agent 统一管理；Agent Team 则共享一份任务列表，队员之间直接收发消息、自我协调，代价是每个队员都是一个独立的 Claude 实例，令牌成本更高。只需要结果的专注任务用 subagent，需要讨论和相互质疑的复杂工作用 agent team。

### Goal：对抗 Agentic Laziness
动机来自一个真实问题，叫 Agentic Laziness。当 Agent 处理一个特别复杂、需要分多步完成的任务时，它常常在完成一部分后就宣布任务已完成。

方法：Harness 暴露三个工具 get_goal、create_goal、update_goal。创建 goal 之后，每一轮 harness 都会把 goal 作为上下文放进 Prompt。只有当 Agent 主动调用 update_goal({ "status": "complete" })，goal 才会被标记为已完成。完成与否不再由模型随口宣布，而是要它显式地、主动地去改一个持久状态，这就堵住了提前收工的退路。

### Humanize：用 Stop Hook 逼 Agent 继续干
Humanize 是一个插件，灵魂是一个 2221 行的 Stop hook（loop-codex-stop-hook.sh），它在 Claude 想要结束时触发。

完整流程：
1. Claude 实现完计划，写一份 round-N-summary.md，尝试退出
2. Stop hook 拦截这次退出，把 summary 喂给 Codex review
3. 如果 Codex 没有输出 COMPLETE，就阻止 Claude 退出，把审查意见作为新指令喂回去，逼它继续干

两个特性：
- bitlesson 记忆：每轮执行前，bitlesson-selector 子 Agent 为当前任务挑出适用的教训。如果一个问题花了多轮才解决，就把它沉淀成一条新教训写进 bitlesson.md
- 人类闸门：在循环启动前，插件用一个子 Agent 出两道关于计划的选择题，考察人类是否真读懂了即将自动执行的计划

### Dynamic Workflows：把编排写成代码
发布于 2026 年 5 月 28 日。最直观的战绩是 Bun 作者 Jarred Sumner 用它把整个 Bun 运行时从 Zig 迁移到 Rust，11 天迁移了 75 万行代码。

要解决的瓶颈：Claude Code 现有的三层协作能力（单实例串行、SubAgent 派生汇报、Agent Team 并行）有一个共同瓶颈——编排者始终是 Claude 本身。它逐轮决策下一步派谁去干什么，而每个 SubAgent 的返回结果都要先回到 Claude 的上下文窗口，它读完才能决定下一步。一旦要协调几十上百个并行任务，上下文窗口根本装不下这么多中间结果。

Dynamic Workflows 的思路是把编排从模型的上下文里搬出来。Claude 不再亲自逐轮调度，而是先把整个编排过程写成一段 JavaScript 脚本，循环、分支、中间结果的收集全部固化在代码里，再交给一个独立运行时去执行。模型只负责生成编排逻辑，运行时负责执行，中间结果不再占用模型上下文。

JS 脚本原语：

| 原语 | 作用 | 关键点 |
|---|---|---|
| agent(prompt, opts) | spawn 一个 SubAgent | 不带 schema 返回字符串；带 schema 时按 JSON Schema 返回结构化结果 |
| pipeline(items, s1, s2, ...) | 每个 item 独立走完所有 stage | 默认选择，无屏障；item A 可以在 stage3 而 B 还在 stage1 |
| parallel(thunks) | 并发跑一批任务 | 有屏障，等全部完成；传的是函数数组 () => agent(...)，不是 promise |
| phase(title) | 进度分组 | 后续 agent 归到这一组 |
| log(msg) | 给用户发一行进度 | 显示在进度树上方 |
| workflow(name, args) | 内联调一个子 workflow | 只能嵌一层 |
| args / budget | 外部参数 / token 预算 | 控制输入与成本 |

关键约束：JS 只能调度，所有文件修改或 shell 命令必须由 SubAgent 执行，脚本本身不碰文件系统。并发上限 16 个 SubAgent 并行，单次运行最多 1000 个。可恢复：没改动的 agent() 调用直接命中缓存，只有改动及其之后的部分才重新跑。

### Auto Dream：给记忆做整理巩固
动机来自记忆腐烂。Memory 让 Claude 边干活边记笔记，但跑了 20 多个 session 后笔记会烂掉，四种表现：矛盾堆积、相对日期失效、过期内容残留、重复冗余。

Auto Dream 分四个阶段：
| 阶段 | 名称 | 做什么 |
|---|---|---|
| Phase 1 | 定位 Orient | ls 记忆目录、读 MEMORY.md 索引、扫一遍现有主题文件 |
| Phase 2 | 收集信号 Gather Signal | 找四类高价值信号：用户的纠正、明确的"记住这个"、跨 session 的重复主题、重要决策 |
| Phase 3 | 巩固 Consolidate | 相对日期转绝对日期、删除被推翻的事实、清理过期记忆、合并重复条目 |
| Phase 4 | 修剪与索引 Prune & Index | 维护 MEMORY.md 索引保持在 200 行以内，按相关性和时近性重排 |

### OpenHuman 记忆系统：层次化加多路检索
约 26k 行，核心是层次化封装加多种检索手段并行。

写入侧：每 20 分钟 auto-fetch 从 Gmail、Notion、Slack 拉数据，每条记录先转成 Markdown 然后切 chunk，chunk 按来源和时间聚类。chunk 逐层向上封存成摘要，每一层有个 buffer。L0 攒够 5 万 token 就封存成一个 L1 摘要节点；每 10 个 L1 摘要再折叠成一个 L2，逐层向上。摘要节点封存后永久不可变，要更新用 tombstone 模式（不改旧节点，封新版本，旧节点遍历时被过滤）。写入永远是 append-only，无锁、无并发冲突。

读取侧四种检索：tree-walk（从顶层摘要节点 BFS 向下 drill_down，子节点按余弦相似度 rerank）、vector search（embedding 相似度）、keyword search（FTS5）、param/tag search（结构化过滤）。

tree-walk 是这套系统区别于普通 RAG 的地方。它不是一次性把相关 chunk 捞出来，而是让模型像读目录一样自顶向下逐层下钻，按需深入，既控制了上下文成本，又保留了全局结构。

### Hermes 自我进化：边干边重构自己
两条线：每个 turn 后的即时复盘，和后台的 Skill 治理。

每个 turn 结束，Hermes fork 一个受限子 Agent 复盘刚才的对话。继承父上下文时命中同一个 prefix cache，省钱。运行时工具白名单只放行 memory 和 skills 两个 toolset，把复盘 Agent 的能力收窄到自我维护这件事上。产出是两选一：写 Memory，或者构建新 Skill。

Skill 后台管理：每个 Skill 有三个状态 active → stale → archived。30 天没用标记为 stale，90 天没用归档。每 7 天后台开一个 Curator 合并 Skill：扫描全部 Skill 找共享首词或域关键词的 Skill 群（prefix 簇），对每个有两个以上成员的簇要么合并到已有候选 Skill 要么新建，把被合并的内容降级为 references、templates 或 scripts，继续循环直到找不到新的簇。这套机制让 Skill 库能自我收敛，不会无限膨胀。

## 更新日志与思考

2026-06-28 本次整理了 Harness 时代的核心概念与一线框架的新特性，搭好了从 Agent Loop 到自我进化记忆系统的主干。后续会补充 Harness 应用实战部分，包括上下文管理（/clear 与 /compact、Fork）、Skill 编写（Skill-creator、写法与示例）以及前沿应用范式（AutoResearch、LLM Wiki）。

Harness 时代有一条清晰的主线。最底层是 Agent Loop（ReAct），所有框架共享同一个内核。往上是一组抽象：Tool Call 和 MCP 提供原子能力，Skill 和 SubAgent 解决上下文成本，Memory 解决跨会话记忆，Hook 和 Goal 把控制权从模型手里部分收回到外层脚本。再往上是 Loop Engineering 这一层理念，人不再写指令，而是定义状态和循环。

前沿特性几乎都在围绕两个矛盾做文章：
1. 上下文窗口装不下长程任务的全部中间结果——Dynamic Workflows 用代码编排把中间结果搬出模型上下文来解
2. 记忆和能力会随时间腐烂膨胀——Auto Dream、OpenHuman 的层次化封装、Hermes 的 Skill 治理都在解这个问题

### 一点思考：workflow 的轮回

2025 年之前，做复杂任务靠的是人手工编排 workflow。开发者用 LangChain、各种 DAG 框架，或自己写胶水代码，把每一步该调哪个模型、该走哪个分支、上一步的输出怎么喂给下一步，全部提前写死。模型在这个阶段只是流水线上一个被调用的节点，编排的智能完全在人脑和人写的代码里。

进入 Harness 时代。大家不再事先画流程图，而是把决策权交给模型。Agent 在 Loop 里自己决定下一步调什么工具、要不要派 SubAgent、什么时候算完成。编排从静态的代码变成了模型每一轮的动态判断。手工 workflow 一度被认为过时了，因为模型够强，不需要人替它规划路径。

而 Dynamic Workflows 又回到了 Workflow，这是一个螺旋上升：
- 第一阶段：编排逻辑由人写，是静态代码
- 第二阶段：编排逻辑由模型在运行时即兴决定，是动态判断
- 第三阶段：编排逻辑重新变回代码，但这段代码由模型自动生成

为什么绕回代码？因为纯动态判断有硬约束——上下文窗口。模型逐轮决策的前提是每一步的中间结果都要回到它的上下文里，一旦任务规模到了几十上百个并行子任务，窗口根本装不下。代码形式的 workflow 恰好把这些中间结果挪出了上下文，让确定性的部分交给确定性的运行时，把模型的智能省下来只用在真正需要判断的地方。

如果这个判断成立，那它指向的趋势可能是：模型的角色正在从执行者上移到编译器。早期模型是流水线里被调用的算子，Harness 时代模型是亲自跑流水线的工人，而 Dynamic Workflows 之后，模型更像是把意图编译成可执行编排的那一层。人定义目标，模型把目标编译成 workflow，运行时执行 workflow，执行中再按需调起新的模型实例。Loop Engineering 讲的人只定义状态，和这里讲的模型把状态编译成循环，其实是同一件事的两端。
