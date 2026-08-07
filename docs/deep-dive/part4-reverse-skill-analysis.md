# Agent Engineering 深度实践 · Part 4

## 开源 Skill 深度分析：reverse-skill

---

> 分析对象：[zhaoxuya520/reverse-skill](https://github.com/zhaoxuya520/reverse-skill)（v1.0.0）
> 网络安全领域 40+ 子 Skills 的路由编排系统。这是 Skill 设计的顶峰案例。
> 本项目已被 Trendshift 收录为热门仓库。

---

## 0. 速览：这到底是什么

reverse-skill 不是"一个"Skill。它是一个 **Skill 路由操作系统**。

```
你："帮我分析这个 APK，看看有没有加密参数"
        ↓
reverse-skill 路由系统
        ↓
RULES.md → MASTER-ROUTING.md → apk-reverse/SKILL.md
        ↓
scope.md 落地 → auth 确认 → tool-index 检查工具 → bootstrap 缺失工具
        ↓
执行分析 → timeline 追加 → Evidence→Finding→Path → 报告生成
        ↓
field-journal 回写经验（下次遇到类似任务自动复用）
```

**规模**：

| 维度 | 数据 |
|------|------|
| 子 Skills | 40+ 个独立模块 |
| 覆盖领域 | APK/IDA/Ghidra/JS/CTF/固件/渗透/EDR/LLM安全/供应链... |
| 路由规则 | R0-R39 共 40 条 PRIMARY 快路径 |
| 支持平台 | Windows + Linux + macOS + Kali |
| 脚本数量 | 30+ PowerShell/Bash 工具脚本 |
| 触发关键词 | 100+ 中英双语触发词 |

---

## 1. 评分

| 维度 | 评分 | 依据 |
|------|:----:|------|
| **单一职责** | 9/10 | 职责清晰：安全任务路由器。没有越界做漏洞库或工具平台 |
| **显式边界** | 10/10 | IDENTITY.md 明确宣告"我们不是 Z3r0"——定义了 7 条"不做的事"。这是边界的最高境界 |
| **可组合** | 10/10 | 40+ 子 Skills 通过路由矩阵 + role-map 组合。lead→cie→cpe→cre→doc 的交接协议 |
| **降级路径** | 9/10 | scope 未授权→STOP。bootstrap 2 次失败→手动。路由未命中→提议新 Skill |
| **可验证** | 10/10 | case-guard.ps1 门禁、smoke.ps1 冒烟、verify-routing-coherence.ps1。完成自检清单 |
| **Token 效率** | 9/10 | 路由分快慢两级（MASTER-ROUTING 快路径 + routing.md 全表）。但整体系统体积巨大 |
| **安全性** | 10/10 | scope-contract 硬门槛、skill-supply-chain 外部安装门闩、sanitize/sandbox/profile 多层 |
| **触发精确度** | 9/10 | 100+ 触发词覆盖所有安全场景。但可能存在误触发 |
| **自主学习/进化** | 10/10 | field-journal + precedent 先例库 + 自动回写经验。这是其他 Skill 完全不具备的 |
| **抗退化设计** | 10/10 | Excuse Rebuttal Table + 上下文注意力布局 + Code Words + 自审清单。防止 LLM "偷懒"的系统性设计 |

**总分：96/100（S 级）**

**分级：L4+**——它不是一个 Skill，它是一个 Skill 的**操作系统**。包含路由、调度、安全门禁、工具管理、经验回写、质量审计——这些是 Agent 框架才有的能力，但它用纯 Markdown + Shell 脚本实现了。

---

## 2. 核心架构

### 2.1 分层设计

```
Layer 0 — 全局注入层
  RULES.md → 写入 ~/.claude/CLAUDE.md（让路由在任何项目中触发）

Layer 1 — 路由层
  MASTER-ROUTING.md（快路径，40 条规则）
  routing.md（三轴全表，精确匹配）
  master-route.ps1（一次成型 triage）

Layer 2 — 安全门禁层（scope gate）
  ops/scope-contract.md → case-init → scope.md
  auth.status=granted 之前禁止一切 ACT

Layer 3 — 角色分配层
  ops/role-map.md（lead/cie/cpe/cre/cae/cbe/llm/doc）
  交接协议（谁→谁、触发条件、交付物）

Layer 4 — 执行层（40+ 子 Skills）
  apk-reverse/ ida-reverse/ js-reverse/ pentest-tools/ ...

Layer 5 — 工具管理层
  tool-index.md（本机路径真相）
  bootstrap-reverse.ps1（按需安装）
  refresh-tool-index（共享注册表）

Layer 6 — 证据与输出层
  Evidence→Finding→Path
  docs-generator（报告生成）
  diagram-generator（图表生成）

Layer 7 — 进化层
  field-journal/（经验回写）
  precedent-auth / precedent-reverse / precedent-pentest（先例库）
```

### 2.2 最关键的设计决策：Scope Gate（安全门禁）

这是 reverse-skill 和所有其他 Skill 最根本的区别——它在执行任何危险操作之前，**强制执行授权检查**：

```markdown
# 任何安全任务在 ACT 之前必须落地 scope.md
scope > auth > status: granted | pending | denied

status != granted → STOP，只允许补授权材料
没有 scope → 只能读文档，禁止主动扫描/Hook/利用
```

**这是在 Skill 层面实现了"操作系统的权限模型"**。你的 flashnote-publish 没有这一步——它假设用户有权限做所有操作。但在安全领域，这个假设是致命的。

### 2.3 角色交接协议（Handoff Protocol）

```
单人 Agent 内的角色切换：

[cpe] 发现可疑加密参数
   → handoff → [cre] 逆向分析
      交付物：样本路径 + 可疑偏移
   → [cre] 还原算法
   → handoff → [cpe] 提供复现命令
      交付物：算法说明 + 密钥/校验逻辑

[any] 阶段完成
   → handoff → [doc] 生成报告
      交付物：Evidence/Finding/Path 草稿
```

**关键**：这不是多 Agent 系统——这是**单 Agent 内用角色前缀标签模拟多角色协作**。不需要额外进程，只需要协议。

---

## 3. 我们从未见过的设计创新

### 3.1 Excuse Rebuttal Table（借口驳斥表）

```markdown
| Agent's Common Excuse | Rebuttal (ENFORCE) |
|---|---|
| "I can skip this step" | FORBIDDEN to skip. Output reason, wait for user |
| "User probably doesn't need this" | NEVER decide for user |
| "Already know how, don't need to read X" | Read X first, then act |
| "Understood the rules, tell me your task" | WORST failure. Proactively route and start |
```

**这解决了一个真实的 Agent 工程问题**：LLM 在执行长指令时会"偷懒"——跳过步骤、猜测路径、假称完成。Excuse Rebuttal Table 在 System Prompt 里预先驳斥了所有常见借口。

### 3.2 Context Window Layout Rules（注意力布局）

```markdown
LLM attention distribution (high→low):
[First 10%]  ████████████ ← 放"立即执行"指令
[Middle 80%] ████░░░░░░░░ ← 放参考资料
[Last 10%]   ████████████ ← 放"MUST NOT skip"和 Checklist
```

**这利用了 LLM 的一个已知特性**：对上下文开头和结尾的注意力显著高于中间部分（Lost in the Middle 效应）。把关键指令放在开头和结尾，中间放不那么重要的参考材料。

### 3.3 Code Words（代码词）

```markdown
alpha → --scope authorized-only
beta  → --approval required
gamma → --destructive false
```

**解决什么问题？** LLM 会把语义化的参数名"优化"掉——比如把 `--approval required` 改成 `--auto-approve`，因为它"觉得"这样更合理。用不透明的代码词（alpha/beta/gamma）可以阻止这种语义漂移。

### 3.4 自我身份宣言（IDENTITY.md）

```markdown
## 我们不是
| Z3r0 有 | reverse-skill 故意不做 |
|---------|-----------------------|
| React 作战台 | ❌ |
| PostgreSQL 证据库 | ❌ |
| Docker 主机池 | ❌ |
```

**为什么要明确"我们不是"？** 因为 LLM 会基于它学过的知识"脑补"功能。如果它在训练数据里见过 Z3r0（一个红队平台），它可能会假设 reverse-skill 有 React UI、有数据库、有 Docker 池。IDENTITY.md 明确告诉它：**我们没有这些，别假设。**

---

## 4. 和我们之前学习的对比

### 4.1 reverse-skill vs book-to-skill

| | book-to-skill | reverse-skill |
|---|---|---|
| Skill 层级 | L3.5 | L4+ |
| 子 Skills | 0（生成的是产物不是子 Skill） | 40+（真正的子 Skill 路由） |
| 路由复杂度 | 4 种模式（Full/Analyze/From Analysis/Fold-in） | 40 条 PRIMARY 快路径 + 三轴全表 |
| 安全门禁 | 有（输入 sanitize + 输出扫描） | 有（scope gate + supply-chain + sandbox + network_profile） |
| 自主学习 | 无 | 有（field-journal + precedent 先例） |
| 工具管理 | 无（只管自己的 extract.py） | bootstrap 系统（检测→安装→刷新索引） |
| 抗退化设计 | 无 | Excuse Rebuttal + Context Layout + Code Words |
| 适用场景 | 单一任务类型（文档→Skill） | 40+ 种安全场景的全域覆盖 |

### 4.2 reverse-skill vs 你的 bootstrap-env

| | bootstrap-env | reverse-skill |
|---|---|---|
| 行数 | 169 | 数千行（跨 40+ 文件） |
| 路由 | 无（单一路径） | 三层路由 |
| 安全 | 无 | scope gate + 授权检查 |
| 自进化 | 无 | field-journal 经验回写 |
| 抗偷懒 | 无 | Excuse Rebuttal Table |

---

## 5. 我们可以学到什么

### 5.1 路由系统是 Skill 扩展的骨架

你的 Skills 是孤立的。如果未来有 10 个 Skills，你怎么让 Claude 知道该用哪个？reverse-skill 的答案是：**在 CLAUDE.md 里注入路由表**，用触发词 + 优先级匹配 PRIMARY Skill。

```
你现在：用户必须明确说出 Skill 名称或触发词
reverse-skill：100+ 触发词自动匹配 40+ Skills
```

### 5.2 Scope Gate 可以应用到你的场景

你的 flashnote-publish 缺少"确认门禁"。可以加：

```markdown
## Pre-flight Gate
BEFORE any git push or tag:
1. pnpm typecheck → must pass
2. pnpm test → must pass
3. git status → must be clean
4. Ask user to confirm version and channel

Any gate fails → STOP, report, do NOT proceed
```

### 5.3 Anti-Laziness 设计可以应用到所有 Skill

你的 Skill 没有防止 LLM 偷懒的机制。加一个简化的：

```markdown
## Execution Rules
- MUST execute every step. Do NOT skip or summarize.
- If a step fails, report the error immediately. Do NOT try to work around it.
- Do NOT guess paths. Read tool-index or config files.
- After completion, run the verification checklist below.
```

### 5.4 分层架构值得学习

reverse-skill 的 7 层架构（路由→安全→角色→执行→工具→证据→进化）不是一次设计的，是演进出来的。但你可以从一开始就意识到：**复杂的 Skill 系统需要分层**。

---

## 6. 新增关键术语

| 术语 | 定义 |
|------|------|
| **路由操作系统** | 不是单个 Skill，而是一组 Skills 的路由、调度、安全门禁和质量管理系统的总称 |
| **Scope Gate** | 在危险操作前强制执行授权检查的安全门禁模式 |
| **Handoff Protocol** | 角色间交接的标准化协议：触发条件 + 交付物格式 |
| **Excuse Rebuttal Table** | 在 System Prompt 中预先驳斥 LLM 常见借口的设计模式，用于防止 Agent 偷懒 |
| **Context Window Layout** | 利用 LLM 注意力分布特性（Lost in the Middle）来安排指令位置的策略 |
| **Code Words** | 用不透明标识符替代语义参数，防止 LLM "优化"参数导致行为漂移 |
| **Identity Declaration** | 明确声明"我们不是什么"，防止 LLM 基于训练数据脑补不存在的能力 |
| **Precedent Library** | 存储历史操作经验的先例库，新任务启动前自动查询复用 |
| **Bootstrap System** | 自动检测→安装→刷新索引的工具管理系统 |
