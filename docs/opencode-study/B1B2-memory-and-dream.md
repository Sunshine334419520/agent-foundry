# B1 · B2 · Memory 记忆系统 × Auto Dream —— 跨会话记忆与它的免疫系统

> 日期：2026-08-28
> 梯队：B 梯队（前沿概念，源自 [docs/zhihu.md](../zhihu.md) + Claude Code 实况核实）
> 前置：第 6 课 compact（[06-context-management.md](06-context-management.md)）——本课大量对照它；第 2 课 Session / 第 5 课 Tools 的"消息即数据"基础
> 配套标本：Claude Code auto memory（本机 `~/.claude/projects/-Users-yangguang-code-agent-foundry/memory/`）
> 状态：理论深挖（A）+ 理论学习（B）完成；源码精读（C）部分完成（opencode 无记忆系统→已确认；Claude Code 官方文档 + 活体标本）；harness 落地（D）待做
> 核实依据：Claude Code 官方文档（memory / claude-directory / commands / settings）+ 已装 CLI v2.1.247 + opencode 稀疏克隆源码排查

## 一句话总结

**跨会话记忆是一套"写 → 存 → 读 → 改删"的持久化系统（B1），而"记忆会腐烂"是这个系统逃不掉的熵增，需要一个低频的整理巩固作业来防腐（B2，Auto Dream）。它们和单会话内的 compact 是同一套"压缩/整理"哲学在不同尺度上的三次落地：compact 让这一个对话活到结束，Memory 让下一次对话不用重新解释，Dream 让记忆本身不会烂掉。** 一个关键的实况修正：Claude Code 的 auto memory 并没有后台 dream 作业——"Auto Dream 四阶段"是行业博客的应然框架，不是产品功能；真正的 "Dreams" 是 Managed Agents API 的研究预览（输入不可变的异步整理任务）。

---

## 一、总览：三个"记忆"概念的一张坐标

| 维度 | **compact**（第 6 课） | **Memory**（B1） | **Dream**（B2） |
|---|---|---|---|
| 解决什么 | 单会话上下文窗口溢出 | 跨会话知识丢失 | 记忆库自身腐烂 |
| 尺度 | 一个会话内部 | 跨会话 | 记忆库整体 |
| 本质动作 | 丢细节、保工作状态 | 提取沉淀、下次复用 | 合并去重、保鲜防腐 |
| 类比 | 进程内 GC（内存回收） | 持久化到磁盘 | 碎片整理 + 数据库 vacuum |
| 触发 | 溢出时被动 | 检测到信号随写 | 低频主动保养 |
| 产物 | 锚定摘要 + summary 消息 | 一条条原子记忆 + 索引 | 更干净的库 + 更精的索引 |

三个都是"压缩/整理"，但**对象、目的、频率完全不同**：

- compact 让**这一个对话**活到结束
- Memory 让**下一次对话**不用重新解释背景
- Dream 让**记忆本身**不会烂掉

> 实况旁证：核实确认 `/compact` 压缩后会重新读磁盘上的 CLAUDE.md，但**不会动 auto memory**——compact 和 memory 在真实产品里是两套互不相干的系统，与这张坐标一致。

---

## 二、B1 · Memory —— 跨会话的持久化记忆

### 2.1 问题定义：会话是"失忆"的

每次新会话 = 全新上下文。模型默认不知道你是谁、偏好什么、上次踩过什么坑，用户被迫一遍遍重新解释背景——这就是 Memory 要消灭的**"重复税"**。

> 一句话目标：**解释一次，终身受用**（对同一用户、同一项目）。

### 2.2 记什么：三类知识 + 四类触发信号

原始定义（zhihu.md）：*"跨会话保存偏好、经验和失败教训。"* 展开成三类：

| 类型 | 是什么 | 实例（本机记忆库真货） |
|---|---|---|
| 偏好 | 用户的工作习惯、风格 | — |
| 经验 | 领域事实、项目约束、非显然的坑 | "DeepSeek 端点要求 thinking 块带 signature 回传" |
| 失败教训 | 做错过什么、为什么、下次怎么办 | "多步工具调用第 2 步就 400，因为 reasoning 没回传" |

**"记什么"不是"什么都记"**——这是自动记忆系统最重要的设计决策。判断"这条值得记"用四类高价值信号（B2 的 Gather Signal 阶段原样复用同一套标准）：

1. **用户的纠正**（correction）——最贵的信号
2. 用户明确的 **"记住这个"**
3. **跨 session 重复出现的主题**——重复 = 还没沉淀下去的信号
4. **重要决策及其理由**——"为什么选 A 不选 B"比"A 还是 B"值钱

**质量线**：这条知识是"非显然、下个会话不知道就会吃亏"的吗？反例：代码里已写着的、git history 能查到的、只对这个对话有意义的一次性信息。

> 真实标本：本机那条 DeepSeek 记忆的正文写的是 *"harness 照 02 文档的设计故意不存/不回传 reasoning……现实与'干净设计'冲突"*——它没记"代码怎么写"（repo 里有），记的是**"为什么现实要求这样 + 冲突在哪"**（repo 里查不到）。这条线就是好记忆和垃圾记忆的分界线。

### 2.3 生命周期四环节：写 → 存 → 读 → 改删

每环问"谁 / 何时 / 怎么做"。

**① 写（Write）**

- 两个流派：**harness 自动写**（模型在会话中检测到信号当场写，主流）；**用户显式写**（`/remember` 之类命令）。
- **当场写优于事后复盘**：信号热乎、上下文都在；缺点是打断主流程，所以实现上往往"模型把记忆动作融进正常工作流"。
- Claude Code 实况：无 flag、无命令，Claude 在会话中基于"用户的纠正和偏好"自行决定写不写，且**跳过代码里能推导的东西**。UI 上 "Saved 2 memories" / "Recalled 2 memories" 即读写动作。

**② 存（Store）**

- **一个项目一个记忆目录，一条记忆一个文件**。为什么"一条一个文件"：
  1. **原子性**：一条记忆可独立增删改，不动到别的记忆
  2. **去重便宜**：写前先查"有没有文件已覆盖这条"，有则更新而非新建
  3. **可检索**：文件名 + frontmatter 的 `description` 就是召回键
- **frontmatter 元数据**（name / description / type / 溯源）+ 正文。`description` 是"要不要展开读全文"的判断依据，索引只放它一句话。
- **类型体系**（user / feedback / project / reference）：分类是为了注入策略不同——项目记忆只在项目内注入，全局记忆全局注入。分类是给"读"准备的，不是洁癖。

**③ 读 / 注入（Read/Inject）**

- zhihu.md 定义：**harness 自动写，启动时注入。**
- 注入的是**索引（index）**，每行一条记忆的一句话摘要；**全量正文只在你判断"这条相关"时才展开**。
- 为什么"索引常驻 + 正文按需"？**上下文成本约束**。和 Skill 渐进披露同一个道理（所有 skill 的名称+描述常驻 system prompt，一多就爆）。记忆索引同理——常驻上下文的部分只能是目录级句子。
- Claude Code 实况：启动时只加载 MEMORY.md **前 200 行或 25KB（先到先算）**；主题文件不加载，任务相关时才用普通文件工具读。`/context` 的 **Memory files** 区可看实际加载了哪些。

**④ 改 / 删（Update/Delete）**

- 记忆不是墓碑：**被推翻的事实要删**；已有覆盖的文件要更新而非复制。
- 单独做也能活，但"什么时候主动查哪些旧记忆该删"是个人不想干的活——**B2 存在的理由**。

### 2.4 活体标本解剖：Claude Code auto memory

解剖 `~/.claude/projects/-Users-yangguang-code-agent-foundry/memory/`（这是真货，随时可看）：

```
memory/
├── MEMORY.md                          ← 索引，一行一条，启动注入
└── deepseek-thinking-signature.md     ← 一条记忆 = 一个文件
      frontmatter: name / description / type=project / originSessionId / modified
      正文: 事实 + Why: + How to apply: + [[相关记忆]] 链接
```

三个观察点：

1. **记的是"为什么 + 怎么用"，不是"是什么"**——"是什么"在代码里查得到。
2. **带 originSessionId**——溯源审计。
3. **[[...]] 互相链接**——记忆成网，B3 层次化/关联检索的种子。

Claude Code auto memory 的产品属性（官方文档核实）：

- 四类记忆类型 user / feedback / project / reference，与 2.3 一致。
- **机器本地、按项目隔离**：一个 repo 的 worktree 共享同一份；不跨机器同步。
- 会话转录 30 天清扫，但 **memory 目录豁免**（v2.1.228+）——记忆是长命的。
- 子代理可有独立记忆（`.claude/agent-memory/<agent>/`），与主会话 auto memory 分开。

### 2.5 opencode 现状核查：没有记忆系统

在 `~/code/opencode` 稀疏克隆排查：`grep memory` 只命中 `plugin/xai.ts`、`cli/heap.ts`（内存用量等，与记忆无关）；`tool/` 无 memory 工具；无 memory/ 目录。

> 结论：**记忆系统不是 harness 的必需品，是加分项。** 横向对比（zhihu.md）：Claude Code 轻量、Codex Auto Memory、Hermes MEMORY.md、OpenHuman 26k 行重型、opencode（当前源码）没有。**同一概念，复杂度上限差三个数量级**——这决定 D 步落地做多轻。

---

## 三、B2 · Auto Dream —— 记忆的免疫系统

### 3.1 问题定义：记忆为什么一定会烂？（熵增）

B1 只解决"怎么记"。**任何会累积的系统都逃不过熵增**。跑了 20+ 个 session 后笔记会烂，四种典型腐烂形态（zhihu.md）：

1. **矛盾堆积**——早期记"用 A"，现实变了记"用 B"，两条都在，下个会话听谁的？
2. **相对日期失效**——"上周踩了坑"，三个月后"上周"失去坐标。
3. **过期内容残留**——项目重构、依赖升级，结论作废但记忆还挂着。
4. **重复冗余**——同一教训记成多条，信号被噪音淹没。

> 类比：记忆系统 = 磁盘，写入只是第一步，不整理就碎片化。**Dream 的名字是线索**——人的记忆靠睡眠中重放与巩固来固化，Agent 的记忆靠 Dream 来整理。

### 3.2 四阶段拆解

**Phase 1 · Orient（定位）** —— *先建地图，再动刀*

- 动作：`ls` 记忆目录 → 读 MEMORY.md 索引 → 扫现有主题文件
- 产出：一张"记忆地图"——库里有什么、多大、哪些主题、哪些看着陈旧
- 心智：不 Orient 就动刀 = 盲人摸象。与 compact 的 `select()` 先算"哪些旧哪些新"同一类"先测绘再裁剪"。

**Phase 2 · Gather Signal（收集信号）** —— *把新发生的事接进长期记忆*

- 动作：从最近的活动抽四类高价值信号（2.2 同款）：用户纠正 / 明确"记住这个" / 跨 session 重复主题 / 重要决策
- 心智：这一步的输入**不是记忆库，是"新会话/新活动"**。把最近散落的写入收集起来准备并库。

**Phase 3 · Consolidate（巩固）** —— *记忆库版的 anchored summary*

- 动作四件：相对日期→绝对日期；删除被推翻的事实；清理过期记忆；合并重复条目
- **与第 6 课同构**：compact 的 `buildPrompt` 原文 *"Preserve still-true details, remove stale details, and merge in the new facts"*——保留仍真 / 删过期 / 并新事实。Consolidate 在做一模一样的事，只是对象从"一段对话"换成"一库记忆"。**这是本课最值得记住的连接点。**

**Phase 4 · Prune & Index（修剪与索引）** —— *保信号密度*

- 动作：索引保持 **200 行以内**（显式上限！）；按**相关性 + 时近性**重排——活的靠前，陈旧的沉底或删除。
- 为什么必须有行数上限？索引常驻 system prompt，每行都是上下文成本。200 行是"目录塞得进上下文、又不被淹没"的经验阈值。
- 心智：**修剪不是"丢了可惜"，是"保住信号密度"。** 噪音淹没信号时，记忆系统反而起反作用。

> 实况旁证：那个"200 行"不是博客编的——它就是 Claude Code 真实的 MEMORY.md 读取上限。博客作者观察到了真实约束，再套了层叙事。

### 3.3 触发时机：不是每轮，是低频

Dream 自己也要跑 LLM，有成本。触发：手动（`/dream` 之类）+ 自动（低频、无用户压力的时刻——会话边界、空闲期、定期）。像碎片整理不能在你写文件时跑。

对照 compact：**被动、高频、单会话**（反应式救火） vs **主动、低频、跨会话**（预防式保养）。

### 3.4 对照表：compact × dream

| 维度 | compact | dream |
|---|---|---|
| 对象 | 一段对话历史 | 一个记忆库 |
| 目的 | 让当前对话能继续（释放窗口） | 让记忆库保持健康（防腐烂） |
| 触发 | 溢出时被动 | 空闲/定期主动 |
| 保留策略 | 最近 2 轮 verbatim + 旧段摘要 | 相关性 + 时近性排序，旧的修剪 |
| 合并方式 | anchored summary 增量更新 | Consolidate 合并重复、更新事实 |
| 成本控制 | SUMMARY_OUTPUT_TOKENS = 4096 | 索引 200 行上限 |
| 本质 | 反应式救火 | 预防式保养 |

> 结论：**compact 和 dream 是同一套操作的两个尺度**。区别全在对象与频率。

---

## 四、产品核实与修正（2026-08-28，基于官方文档 + CLI v2.1.247）

本节记录"权威参考"的核实结果——学习地图的纪律：**权威参考是候选切入点，深挖时再确认**。

### 4.1 活体标本 = 真实 Claude Code auto memory ✅

- 四类记忆类型、索引常驻 + 正文按需、写入自动检测、机器本地按项目隔离——全部对上（见 2.3 / 2.4）。
- MEMORY.md 读取上限：**前 200 行或 25KB，先到先算**。
- 写入机制：无 `--memory` flag、无 `# memory` 命令；Claude 基于纠正/偏好自行决定。开关：`/memory` 命令或 `autoMemoryEnabled` 设置、`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` 环境变量。
- 归属：auto memory 每个 repo 一份（worktree 共享）；CLAUDE.md 才是用户自己写的四层（managed policy → user → project → local）。

### 4.2 修正：Claude Code 里没有 /dream，四阶段是博客框架 ⚠️

- 官方文档、命令参考、已装 CLI 都查不到 `/dream` 命令与 "Auto Dream" 设置。"Orient → Gather Signal → Consolidate → Prune" **不是 Anthropic 官方术语**，是博客对记忆整理的框架化表述。
- 真正的 **"Dreams"** 是 Managed Agents（服务器托管 API）研究预览功能：
  - 异步记忆整理任务：读入一个已有 memory store + **1–100 个会话转录** → 产出一个**新的、重组的 store**（去重、最新值替换过期/矛盾、浮出新洞见）。
  - **输入 store 永不修改**；人工审阅后决定 attach 还是丢弃。**手动触发**（`POST /v1/dreams`），不自动跑。
  - 这是"整理应该独立、低频、输入不可变、产出需人工审阅"的模板——呼应 B3 OpenHuman 的 tombstone 哲学（不改旧节点，封新版本）。
- zhihu.md 对比表"Claude Code 自我改进 = Auto Dream"这一格，至少在 2026-08 站不住。

### 4.3 最深的教学点：auto memory 没有任何后台整理作业

Claude Code 的记忆库**没有 consolidate/dream/prune 后台任务**，靠两条"通过摩擦倒逼纪律"的设计保持健康：

1. 系统提示里要求**保持索引精简**（一行一条、细节进主题文件、合并删旧）；
2. **超限写入会报错**——索引超 200 行/25KB，写能成功但下次加载超出部分被丢掉，Claude 被迫回头重写索引。

> **"Auto Dream 四阶段"是行业的"应然"（记忆应该被定期整理巩固）；Claude Code 的现状是"实然"（用约束和摩擦逼出自律，不做后台保养）。学 B2 学的不是"哪个产品实现了它"，而是"记忆会腐烂"这个问题意识 + 一套可执行的整理动作。**

---

## 五、合流：B1 + B2 是一套系统

```
会话进行中 → 检测到信号 → 写记忆 (B1 写)
            → 启动时索引注入 (B1 读) → 下个会话免解释
            → 低频 Dream (B2) → 记忆库去腐 → 索引更精 → 注入更有效
```

一句话：**B1 是"存"，B2 是"养"。** 没有 B2，B1 迟早烂掉；没有 B1，B2 无物可养。记忆是有生命的：写入是输入，Dream 是代谢——所以它叫 Dream。

连线未来：

- **B3（OpenHuman）** = B1 的**规模化**变体：单文件单事实 → chunk→L1 摘要→L2 层次，解决"记忆多了怎么不爆上下文还找得到"。tombstone 模式是 B1 第④环的极端版。
- **B9（Hermes Skill Curator）** = B2 的**平行移植**：Skill 和 Memory 面临同一问题（常驻 system prompt 成本约束 + 会腐烂膨胀），解法同构（active→stale→archived + 定期合并）。**B2 的全套思想到 B9 直接复用。**
- **对我们 harness**：第 6 课 compact 是"单会话内"，B1+B2 是"跨会话"——这次要新建的维度。

---

## 六、对照我们的 harness（为 D 步铺路）

现在 harness 的 Session 是单会话的：`toModelMessages()` 全量发送，compact 只有第 6 课的落地版本。**跨会话记忆是全新维度。**

| 维度 | 参考实现 | harness 现状 | D 步可做 |
|---|---|---|---|
| 记忆存储 | 每项目 memory/ 目录，一条记忆一个文件 + frontmatter | 无 | 最小版：memory/ 目录 + 文件约定（name/description/type/正文） |
| 索引注入 | MEMORY.md 前 200 行/25KB，启动注入 | 无 | 启动时读 MEMORY.md 文本块，注入组装上下文处 |
| 写入口 | 模型在会话中检测信号自动写 | 无 | 一个 `saveMemory()` 工具（检查已有文件 → 更新 or 新建） |
| 读入口 | 主题文件按需展开 | 无 | 一个 `readMemory()`/搜索工具（按 description 召回） |
| 整理（B2） | Dreams API：异步、输入不可变、产出审阅 | 无 | 最小手动版：一个 `/dream` 命令跑 Orient→Gather→Consolidate→Prune 各一步 |

**D 步顺序建议**：先 B1（存储 + 索引注入 + 写/读入口，够轻），B2 用最小手动版。

---

## 七、思考题（B 步讨论，确认理解）

1. **判断题**：compact 的 Consolidate 和 dream 的 Consolidate 做的是同一件事。对/不对？差在哪三个维度？
2. 为什么记忆要"一条一个文件"而不是"一个总文件不断 append"？从去重、更新、检索三个角度各给一条理由。
3. 为什么索引只放一句话、正文按需展开？这和 Skill 渐进披露、系统提示词成本是什么关系？
4. 索引为什么设"200 行 + 相关性/时近性重排"？膨胀到 2000 行会发生什么（连锁反应）？
5. 相对日期对跨会话记忆为什么是毒药？compact 那边对应的动作是什么？（提示：06 文档 system.ts 为什么动态注入 `Today's date`）
6. 如果你是 harness 作者，"这条值得写进记忆"你用什么信号判断？为什么"用户纠正"比"用户夸你"更值得记？
7. **设计题**：我们 harness 只有单会话 compact。加 B1 的最少实现是什么（目录/索引注入/写入口/读入口各自长什么样）？先 B1 后 B2 的顺序你认同吗？

---

## 八、参考资料

- [docs/zhihu.md](../zhihu.md) —— B 梯队概念底稿（Harness 领域核心概念）
- [06-context-management.md](06-context-management.md) —— 第 6 课 compact（对照基准）
- Claude Code memory 文档：https://code.claude.com/docs/en/memory.md
- Claude Code .claude 目录文档：https://code.claude.com/docs/en/claude-directory.md
- Dreams（Managed Agents）文档：https://platform.claude.com/docs/en/managed-agents/dreams.md
- Dreams Beta API：https://platform.claude.com/docs/en/api/beta/dreams.md
- opencode 稀疏克隆源码排查（`packages/opencode/src`，2026-08-28）
