# B3 · OpenHuman 层次化记忆 —— 当记忆多到"整理"都必须靠架构

> 日期：2026-08-28
> 梯队：B 梯队（前沿概念，源自 [docs/zhihu.md](../zhihu.md) + GitHub 实况核实）
> 前置：[B1B2-memory-and-dream.md](B1B2-memory-and-dream.md)（B1 扁平记忆 / B2 整理巩固）——本课是它们的"规模化 + 自动化"变体；第 6 课 compact（Consolidate 递归化的参照）
> 配套参考：OpenHuman（`tinyhumansai/openhuman`，本地优先开源个人 AI 助手，Rust + TS）
> 状态：理论深挖（A）+ 理论学习（B）完成；源码精读（C）未做（本地无克隆，仅 web 核对官方 gitbooks + DeepWiki 拆解）；harness 落地（D）待做
> 核实依据：OpenHuman 官方 gitbooks（memory-tree / retrieval）+ DeepWiki 源码拆解 + zhihu.md（转述，已对账）

## 一句话总结

**OpenHuman 层次化记忆是 B1/B2 的"规模化 + 自动化"变体：当记忆自动海量涌入（每 20 分钟拉 Gmail/Notion/Slack/日历/commit）、人无法干预时，"整理"必须从判断变成架构。写入侧用 bucket-seal（LSM-tree 式）——L0 chunk 满则封存成不可变的 L1 摘要，逐层滚到 L2……，更新走 tombstone（封新版本取代旧版本，遍历时过滤），永不改写；读取侧用 tree-walk——模型像读目录一样对摘要树逐层下钻，只拉当前层，既控上下文成本又保全局结构。核心哲学："OLAP，不是 RAG"——不靠向量相似度一次捞 top-k，而是把同一份数据按来源/时间/实体三个正交维度索引。** 它没有发明新概念，是把 B1/B2 每条原则都规模化 + 自动化了。

---

## 备课记录（产品核实）

- 本地无 OpenHuman 克隆，用 web 核对官方 gitbooks 与 DeepWiki 源码拆解。
- 三处与 zhihu.md 转述的出入：
  1. zhihu.md 说"读取侧四种检索"——**实际当前 repo 是 7 种 mode**（见 §四）。
  2. 历史上曾有 `query_global` / `query_topic` 两个 mode，**后来被删了**——source tree 持有全部内容，walk 来源层次 + 实体索引即可重建时间和主题投影。zhihu.md 是旧版 + 简化的描述。
  3. zhihu.md 报告的阈值（L0 攒 5 万 token 封 L1、每 10 个 L1 折 L2）**数字随版本变**；可确认的是机制："buffer 满即封存"。

---

## 一、定位：放进我们的坐标

B1/B2 回答"跨会话怎么记 + 怎么不让它烂"，但都踩着一个没挑明的假设：**记忆量是几十条、人能干预**。B3 回答的是这个假设破裂之后的问题：

> **当记忆自动海量涌入、人无法干预时，结构本身必须接管"整理"。**

| 维度 | compact | B1/B2 | B3 |
|---|---|---|---|
| 尺度 | 单会话 | 跨会话 | 跨会话 + 海量 |
| 记忆量 | 一轮对话 | 几十条 | 百万级 chunk |
| 结构 | 平铺消息 | 扁平文件 | 三棵正交树 |
| 维护方式 | 溢出触发 | 人工 / dream 判断 | **架构自愈（不可变封存）** |
| 关键机制 | anchored summary | 索引 + 按需 | tree-walk + bucket-seal |

**一句话定位：B1/B2 的"整理"靠判断（dream 的 Consolidate 是 LLM 判断该删什么、并什么），B3 的"整理"靠架构（不可变封存让记忆自我纠正，不用判断）。** 这是两个哲学的分岔口——本课的核心就是这条分岔。

---

## 二、问题定义：扁平记忆在什么规模下破产？

OpenHuman 是本地优先的开源个人 AI 助手，Rust + TS，每 ~20 分钟自动从 Gmail / Notion / Slack / 日历 / 代码 commit 拉数据。这意味着三件事：

1. **你无法手动维护**——写入是持续的海量输入，几百万 chunk 量级。
2. **B1 的"一条一文件 + 索引"崩了**——几百万个文件，200 行索引上限怎么装？
3. **B2 的 dream（定期人工/LLM 整理）崩了**——每 20 分钟来一批新数据，靠低频 Consolidate 根本赶不上。

所以答案只能是：**让结构在写入时就把数据组织成可导航的层次，读取时按需下钻，更新靠版本化而非改写。**

核心决策一句话（来自作者自己的定位）：**"OLAP，不是 RAG。"** —— 不把一切塞进向量库靠 embedding 相似度捞，而是把同一份原始数据按**三个正交维度**建索引：来源（source）、时间（global）、实体（topic）。

---

## 三、写入侧：bucket-seal（桶封存）架构

写入路径是 hot / cold 两条路：

- **Hot path（无 LLM，快）**：`canonicalize`（所有来源 → Markdown）→ `chunker`（≤3k token 分段，确定性 content-hash ID）→ **信噪比闸门**（admission gate，丢弃广告/机器人消息等垃圾 chunk）→ 快速打分 → 持久化 SQLite + `.md` → 入队重活。
- **Cold path（后台 worker，3–4 个，用 LLM 并发信号量门控）**：embedding、实体抽取、桶封存（L0→L1→…）、每日 digest。

### 三棵正交的树

| 树 | 组织维度 | 机制 |
|---|---|---|
| **Source Tree**（`tree_source/`） | 来源 + 时间 | 每来源一个滚动 buffer（每个 Gmail label、Slack 频道、上传文档）。新 chunk 进 **L0 buffer**，满则"封存"成 **L1 摘要**，L1 滚成 L2…… |
| **Topic Tree**（`tree_topic/`） | 实体 | 按人/项目/股票/repo 的摘要，**懒物化 + 热度阈值驱动**——只有频繁出现的实体才建深摘要，低频实体只给索引引用（省 LLM 成本） |
| **Global Tree**（`tree_global/`） | 时间 | 跨来源的每日 digest = 自动日记 |

### 最核心的架构决定：封存即不可变（LSM-tree 思想）

- 摘要节点封存后**永久不可变**——不重写、不编辑。
- 要更新 → **封新版本（tombstone 模式）**，旧版本在遍历时被过滤。
- 写入永远 **append-only** → 无锁、无并发冲突。
- 为什么？**防"自我改写记忆"的语义漂移**——每次重写都可能悄悄改变原义；版本化让"旧版本永远可查、新版本显式取代"。

> **这里就是和 B2 的分岔。** dream 的 Consolidate 是"删过期、合并重复"——**改写**，靠 LLM 判断；OpenHuman 的答案**不改写**，让新旧版本自然取代、读取时过滤。**一个靠判断维护，一个靠架构自愈。**

---

## 四、读取侧：tree-walk 检索原语

Agent 面对的是**一个**工具 `memory_tree`，一个 `mode` 字段分发到不同实现，所有 mode 返回统一的 `RetrievalHit` schema：

| Mode | 做什么 | 典型用法 |
|---|---|---|
| `search_entities` | 模糊 LIKE 查规范实体索引，surface name → canonical id | "Alice 说了什么？" |
| `query_source` | 按来源 + 时间窗口的摘要检索，可选语义重排 | "总结上周 #eng 频道" |
| `drill_down` | 对摘要节点的 `child_ids` 做 **BFS 下钻**，可下多层 | 把粗摘要展开成细粒度子节点 |
| `cover_window` | 覆盖 `[since, until]` 时间窗的最小节点集 | "最近 24h 回顾" |
| `fetch_leaves` | 按 id 批量取原始 leaf chunk（上限 20） | 引用时拿原始文本 |
| `ingest_document` | 写入一棵树（**唯一写 mode**） | 持久化抓来的网页 |
| `walk` / `smart_walk` | **确定性 E2GraphRAG**——提取查询实体、在实体图与稠密摘要间路由、**无 LLM**、返回排序证据 | 一句话问答，无需 agent loop |

几个设计点：

- **RetrievalHit 统一 schema**：`node_id`、`node_kind`（**leaf vs summary**——消费方据此分支：只对 summary 下钻）、`tree_id/kind/scope/level`（溯源，UI 标注用）、`content` 片段、`entities/topics`、**`time_range`（RFC3339）**、`score`、`child_ids`（下钻游标）、`source_ref`（叶子指回原来源）。
- **`time_range` 是"共同轴"**：所有检索结果都带时间窗，可跨来源排序——三棵正交树里"时间"维度的落地。
- **`walk`/`smart_walk` 无 LLM**：把"该走实体图还是摘要树"的判断固化在确定性路由代码里——呼应 Loop Engineering："确定性部分交给确定性运行时，模型智能省下来只用在真正需要判断的地方。"

---

## 五、tree-walk vs 普通 RAG：为什么"结构"值 26k 行

| | 普通 RAG | OpenHuman tree-walk |
|---|---|---|
| 检索方式 | 一次性 top-k 相似 chunk 进上下文 | 自顶向下逐层下钻，按需深入 |
| 上下文成本 | top-k 全进窗口，常爆 | 每层只拉当前层，成本可控 |
| 结构 | 无——看到的是碎片 | 保留全局结构，知道"自己在树的哪里" |
| 检索质量依赖 | 全靠 embedding 相似度 | 实体路由 + 语义重排 + 关键词 + 时近性**多信号混合打分** |
| 维护 | 向量库几乎免维护 | 树需要后台持续维护（summarizer / 实体抽取） |

**tree-walk 的本质 = B1B2 文档 Q3 讲的渐进披露（索引→正文两级）推广成 N 级树**：目录 → 章节 → 段落 → 原文。模型像读一本书的目录一样下钻，只在需要时深入，既控上下文成本又保全局结构——这就是它区别于 RAG 的地方，也是"取 tree-walk 思想"这句话的意义。

---

## 六、与 B1/B2 的全面对照（伏笔兑现）

| B3 的机制 | 兑现了 B1/B2 的什么 | 关系 |
|---|---|---|
| L0→L1→L2 递归摘要 | B1B2 文档 Q1："compact/dream 只是阶梯两级，B3 扩成 N 级" | compact 的 Consolidate **递归化** |
| tombstone / 不可变封存 | B1 生命周期第④环"改/删" | 从"改写"升级为"版本化取代" |
| tree-walk 逐层下钻 | B1B2 文档 Q3 的渐进披露（索引→正文） | 从两级推广成 N 级树 |
| summary node | compact 的 anchored summary | 海量版 |
| 热度驱动懒物化 topic tree | Dream 的时近性/相关性重排 | 把"排序"变成"物化时机"（不常提的实体根本不建摘要） |
| 信噪比闸门（admission gate） | B1 的"质量线"（非显然才记） | 自动化 + **前置到写入前** |
| 混合多信号打分 | — | 检索侧的新维度 |

**整张表的读法**：B3 没有发明新概念，它是把 B1/B2 里每一条"原则"都**规模化 + 自动化**了。看懂 B3 的唯一捷径是先看懂 B1/B2。

---

## 七、工程取舍：26k 行买来了什么、代价是什么

- **买来了**：海量自动摄入下的免人工整理、稳定的语义（不可变）、可导航的结构（tree-walk）、本地可读（每个 chunk 也是 `.md`，在 Obsidian vault 里可查可改可删）。
- **代价**：26k 行代码、持续后台 worker（LLM 成本）、实体解析、三树维护、七种检索模式、混合打分。这是**个人助理产品**的选择（OpenClaw / Hermes 那一挂），不是编码 harness 的选择。
- **对照**：Claude Code 记忆 = 几十条、人工可干预、扁平；OpenHuman = 百万级、自动摄入、层次化。**同一概念，复杂度上限差三个数量级**——B1B2 文档 §2.5 说过这句，B3 就是那"重的一端"的实物。

### 对我们 harness 的启示（D 步）

我们的记忆量级是几十条（B1/B2 的 D 步范围），**不需要 26k 行**——学习地图明说"取 tree-walk 思想"。可取三点、不取三样：

- **取**：① tree-walk 思想——将来把"索引→正文"两级扩成"索引→摘要→原文"多级，读取时逐层下钻；② 不可变封存——将来记忆要支持版本更新时学 tombstone（新版本取代 + 遍历过滤），不学就地改写；③ `time_range` 共同轴——检索结果统一带时间窗。
- **不取**：三树正交、实体解析、向量/embedding、后台 worker——那是海量自动摄入才需要的东西。
- **最小落地**：在 B1 的索引行里加一个"摘要行"（某条记忆正文太长时：索引一句话 → 摘要 → 原文两级下钻）——这就是 tree-walk 的最小种子，几十条的规模下也够用。

---

## 八、思考题（确认理解）

1. **判断题**：OpenHuman 用"不可变封存"代替了 dream 的"改写式整理"。这是"同一件事"还是"两个哲学"？各自的取舍？（提示：改写有语义漂移风险，版本化有读取过滤成本）
2. 为什么写入要拆 hot / cold 两条路？为什么 hot path 不含 LLM、cold path 要用并发信号量门控？
3. "OLAP，不是 RAG"——为什么向量相似度不够？tree-walk 在哪些场景下优于 top-k 检索？（提示：结构、上下文成本、跨来源时间窗）
4. 信噪比闸门和 B1 的"质量线"是同一个思想吗？差在哪？（提示：一个写入前自动过滤，一个靠写入者判断）
5. 热度驱动的 topic tree——为什么不给所有实体都建深摘要？这和 Dream Phase 4 的"时近性/相关性重排"是什么关系？
6. **设计题**：我们 harness 的记忆（几十条）如果要引入"一级摘要层"（索引→摘要→原文），哪些场景值得？和 B1 的"一条一文件"怎么共存？

---

## 参考资料

- [docs/zhihu.md](../zhihu.md) —— B 梯队概念底稿（含 OpenHuman 记忆系统概述，已与实况对账）
- [B1B2-memory-and-dream.md](B1B2-memory-and-dream.md) —— 前置：B1 扁平记忆 / B2 整理巩固 / 渐进披露（Q3）
- [06-context-management.md](06-context-management.md) —— 第 6 课 compact（Consolidate 递归化的参照）
- OpenHuman retrieval 文档：https://github.com/tinyhumansai/openhuman/blob/main/gitbooks/features/obsidian-wiki/retrieval.md
- OpenHuman memory-tree 文档：https://github.com/tinyhumansai/openhuman/blob/main/gitbooks/features/obsidian-wiki/memory-tree.md
- DeepWiki · Memory & Neocortex：https://deepwiki.com/tinyhumansai/openhuman/5-memory-and-neocortex
- DeepWiki · Memory Ingestion & Unified Store：https://deepwiki.com/tinyhumansai/openhuman/5.1-memory-ingestion-and-unified-store
