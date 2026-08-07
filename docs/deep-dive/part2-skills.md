# Agent Engineering 深度实践 · Part 2

## Skill：从指令模板到可组合 Agent 原语

---

> 你的 bootstrap-env 和 flashnote-publish 是优秀的 L3 Skill。但这只是 Skill 的一种形态。本章从原理层重新拆解——Skill 到底是什么、怎么工作、以及还能怎么用。

---

## 0. 你的现有 Skill 审计

在深入原理之前，先看你自己写的东西处于什么水平。

### 0.1 bootstrap-env

```
类型：L3 — Tooled Skill（多步骤 + tool use）
复杂度：高（OS 检测 → 版本对比 → 条件安装 → PATH 修复 → 验证）
协作：独立执行，不调用其他 Skill
```

**做得好的**：
- 清晰的决策矩阵（Quick Decision Matrix）——Claude 不靠猜
- 明确的状态转换（Detect → Install → Verify → Stop）
- Gotchas 段——把坑提前标注，Claude 不会踩
- 显式的停止条件（"Do not run pnpm install"）

**可以提升的**：
- 没有错误恢复路径——如果 Detect 阶段某个检测脚本挂了，没有"跳到手动模式"的指引
- 169 行的 Skill 已经很长了——Claude 加载它时占用的 context window 不小

### 0.2 flashnote-publish

```
类型：L3 — Tooled Skill（编排型，分 5 个阶段）
复杂度：高（版本计算 → 预检 → git 操作 → CI 监控 → 通知）
协作：独立执行
```

**做得好的**：
- 分阶段设计（Step 0-5），每阶段有明确的输入输出
- 工具封装（publish-git.py）——缩小权限范围
- Beta/Stable 双通道的决策逻辑
- 异步监控（Monitor tool）

**可以提升的**：
- 没有"如果 CI 失败怎么回滚"的路径
- 和 bootstrap-env 没有任何协作关系——虽然它们逻辑上有关联（发布前应该确认环境正常）

---

## 1. Skill 的原理：你到底创造了什么

### 1.1 Skill 的本质 = 特化 System Prompt

当你触发一个 Skill 时，Claude Code 做的事情极其简单：

```
正常的 System Prompt:
┌──────────────────────────────────────┐
│ 内置 System Prompt                    │
│ CLAUDE.md                            │
│ Memory（按需）                        │
│ 工具定义                              │
└──────────────────────────────────────┘

触发 Skill 后的 System Prompt:
┌──────────────────────────────────────┐
│ 内置 System Prompt                    │
│ CLAUDE.md                            │
│ Memory（按需）                        │
│ 工具定义                              │
├──────────────────────────────────────┤
│ ★ SKILL.md 全文 ★                    │  ← 整份注入
│ "Bootstrap Env — First-Clone..."     │
│ "Required Base Env | Tool | Floor..."│
│ ...全部 169 行...                     │
└──────────────────────────────────────┘
```

**Skill 没有运行时。没有虚拟机。没有沙箱。** 它就是一整块追加的 System Prompt，里面写好了指令，让 Claude 照做。

### 1.2 这和你自己说一遍有什么区别？

你自己说"帮我初始化环境，需要检查 node ≥ 20、pnpm ≥ 10、Python 3 要是真的……"也能达到同样效果。

**Skill 的价值不在于"能不能做到"，而在于三个字：**

| 价值 | 含义 |
|------|------|
| **可靠性** | 你口述可能漏掉 Gotcha #4。Skill 每次都完整 |
| **复用性** | 你不需要记住 169 行的初始化流程。一句话触发 |
| **可演化** | 你发现新的坑 → 更新 Skill → 下次自动生效。你的知识被"固化"了 |

### 1.3 Skill 的触发机制

```
你说："帮我设置一下开发环境"
        ↓
Claude Code 匹配所有 Skill 的 description 字段
        ↓
bootstrap-env: "One-click initialize... Triggers on: first clone, setup environment,
                bootstrap toolchain, initialize base env..."  → "设置环境" 匹配！
        ↓
加载 SKILL.md → 注入 System Prompt → Claude 按 Skill 指令执行
```

**关键**：`description` 里的触发词决定了 Skill 什么时候被激活。你写得越精确，误触发越少。

---

## 2. Skill 的四级进化

### 2.1 L1 — Template Skill（模板型）

纯文本指令，没有步骤，没有工具调用。

```markdown
---
name: reply-chinese
description: Always reply in Chinese.
---

用中文回复所有消息。保持简洁，不要啰嗦。
```

**特征**：只是改变了 Claude 的"说话方式"，没有新增能力。

### 2.2 L2 — Guided Skill（引导型）

有步骤清单，但不强制使用特定工具。

```markdown
---
name: code-review
description: Review code changes for bugs, security, and style issues.
---

进行代码审查，按以下顺序：

1. **正确性**：逻辑是否有 bug？边界条件是否处理？
2. **安全性**：是否有注入风险？是否有越权操作？
3. **可维护性**：命名是否清晰？是否有重复代码？
4. **风格**：是否符合项目的 CLAUDE.md 规范？

输出结构化的审查报告，按严重程度排序。
```

**特征**：给了思维框架，但 Claude 自己决定用什么工具去执行。

### 2.3 L3 — Tooled Skill（工具型）★ 你的水平

有明确步骤 + 指定使用特定工具。

```markdown
---
name: flashnote-publish
description: Publish a new FlashNote release...
---

## Step 1 — Pre-flight checks
```bash
pnpm typecheck   # must pass
pnpm test        # must pass
```
...
```

**特征**：不仅告诉 Claude"做什么"，还告诉它"用什么做、怎么验证"。**你的两个 Skill 都在这一层。**

### 2.4 L4 — Orchestrator Skill（编排型）

不自己做，而是调度其他 Skill。

```markdown
---
name: full-release
description: Full release pipeline — from env check to publish.
---

执行完整的发布流程：

## Phase 1 — 环境确认
触发 Skill: bootstrap-env（验证工具链）

## Phase 2 — 质量门
运行 pnpm typecheck && pnpm test
如果失败 → 修复 → 重新运行 → 不通过不进入下一阶段

## Phase 3 — 发布
触发 Skill: flashnote-publish（选择 channel → 发布）

## Phase 4 — 验证
发布完成后，检查 GitHub Release 的下载链接是否可访问
```

**特征**：Skill 本身不包含执行细节，而是**组合已有的 Skill** 形成一个更大的流程。

**这是你还没触及的层级。**

---

## 3. Skill 的高级模式

### 3.1 模式一：Skill 链式调用

一个 Skill 的输出作为另一个的输入：

```
需求分析 Skill → 架构设计 Skill → 编码 Skill → 测试 Skill
      ↓               ↓              ↓             ↓
   需求文档.md     架构图.md      src/*.ts     test-report.md
```

要实现这个，需要定义 Skill 之间的**输出格式约定**。比如架构设计 Skill 的最后加一句：

```markdown
## 输出格式
本 Skill 完成后，将架构决策写入 `docs/architecture-decision.md`，
包含以下章节：1. 技术选型 2. 组件树 3. 数据流
```

下一个 Skill 就知道去读 `docs/architecture-decision.md`。

### 3.2 模式二：Skill 参数化

不是所有 Skill 都要硬编码。可以接受参数：

```markdown
---
name: generate-component
description: Generate a new React component file.
---

## 参数
用户会提供：组件名（PascalCase）、所属模块路径、Props 列表

## 执行
1. 在 `src/renderer/components/<module>/` 下创建 `<Name>.tsx`
2. 按 CLAUDE.md 组件规范生成模板：
   - interface Props { ... }
   - export function <Name>({ ... }: Props): ReactElement
3. 在 `src/renderer/components/index.ts` 添加导出
```

使用：`"用 generate-component 创建一个 UserAvatar 组件，模块是 common，props 有 src:string 和 size?:number"`

### 3.3 模式三：Skill 中的决策树

在 Skill 里嵌入条件分支逻辑：

```markdown
## 部署 Skill

1. 检测当前分支
   ├── main → 生产部署（严格验证）
   ├── develop → 预发布部署（标准验证）
   └── feat/* → 拒绝部署，提示"请先合并到 develop"

2. 如果是生产部署：
   ├── 检查是否有未合并的 release PR
   ├── 运行完整的回归测试
   └── 部署后等待 5 分钟 → 检查监控指标 → 异常则回滚

3. 如果是预发布部署：
   ├── 运行冒烟测试
   └── 部署 → 通知测试团队
```

### 3.4 模式四：Skill 中的"提前终止"与"人工插入"

```markdown
## 危险操作 Skill

1. 评估操作风险等级
   ├── 低风险（读操作）→ 直接执行
   ├── 中风险（本地文件修改）→ 执行但记录
   └── 高风险（数据库操作、远程部署）→ **暂停，向用户确认**

2. 高风险确认格式：
   "即将执行以下操作：
   - 删除表 xxx 的 1200 条记录
   - 影响范围：xxx 模块
   - 预计不可逆
   是否继续？[y/N]"

3. 用户拒绝 → **终止 Skill，不执行任何后续步骤**
4. 用户确认 → 执行 → 记录操作日志
```

你的 bootstrap-env 里其实已经有了类似逻辑（admin hand-off pattern），但没显式建模为"决策节点"。

### 3.5 模式五：Skill 自检与修正

```markdown
## 重构 Skill

1. 分析当前代码 → 列出重构目标
2. 逐文件重构
3. **每完成一个文件后**：
   └── 运行 `pnpm typecheck` → 通过则继续，失败则回滚该文件
4. 全部完成后：
   └── 运行 `pnpm test` → 全量验证

如果在第 3 步连续 2 个文件回滚 → 暂停，报告问题，请求人工介入
```

---

## 4. 从你的 Skill 到 L4 的路径

### 4.1 你现在的架构

```
bootstrap-env        flashnote-publish
     │                      │
     │ 各自独立              │ 各自独立
     │                      │
     ▼                      ▼
   环境就绪              发布完成
```

两个 Skill 没有关系。但实际上——**发布前应该确保环境可用**。

### 4.2 L4 改造：编排型 Skill

```markdown
---
name: release-pipeline
description: Full release pipeline — env check → quality gate → publish → verify.
---

本 Skill 编排以下子流程，不包含具体执行细节。

## Phase 1 — 环境确认
Claude 自行判断是否需要运行 bootstrap-env：
- 检查 node、pnpm 版本是否满足要求
- 如果满足 → 跳过
- 如果不满足 → 运行 bootstrap-env Skill

## Phase 2 — 质量门
```bash
pnpm typecheck && pnpm test
```
不通过 → 报告失败原因 → 停止

## Phase 3 — 发布
触发 Skill: flashnote-publish
询问用户 channel（stable/beta）

## Phase 4 — 发布后验证
```bash
python3 .claude/scripts/ci-check-release.py <version>
```
成功 → 通知用户
失败 → 分析 CI 日志 → 给出修复建议
```

**关键变化**：你不再需要分别记住"先检查环境，再发布"。`release-pipeline` 把两个 Skill 串起来了。

---

## 5. Skill 设计原则总结

| 原则 | 好的 Skill | 差的 Skill |
|------|-----------|-----------|
| **单一职责** | "初始化开发环境" | "初始化环境 + 安装依赖 + 跑测试 + 启动" |
| **显式边界** | "不运行 pnpm install" | 不说清楚边界，Claude 自由发挥 |
| **可组合** | 输出文件路径、状态描述 | 输出只在对话里，无法被其他 Skill 消费 |
| **有降级路径** | "如果自动安装失败，给出手动命令" | 只有一条 happy path |
| **可验证** | 每步有 verify 命令 | "做完就行" |
| **有终止条件** | "max 3 retries → 转人工" | 没有循环上限 |

你的 bootstrap-env 在"显式边界"和"可验证"上做得非常好；在"降级路径"（admin hand-off）上也做了，但不够系统化。flashnote-publish 的"可组合"和"终止条件"是弱项。

---

## 6. Skill vs Memory vs CLAUDE.md 的最终决策框架

```
你需要让 Claude 知道一段信息。问三个问题：

1. 这段信息是一个"流程"还是"知识"？
   ├── 流程（先做什么、后做什么、怎么验证）→ Skill
   └── 知识（事实、规则、偏好）→ 继续问题 2

2. 每次对话都需要吗？
   ├── 是 → CLAUDE.md（全量预加载）
   └── 否 → 继续问题 3

3. 是团队共享还是个人专属？
   ├── 团队共享 → CLAUDE.md 指针 + docs/ 详细文件
   └── 个人专属 → Memory（按需检索）
```

| 例子 | 为什么放这里 |
|------|-------------|
| 组件导出必须用 named export | CLAUDE.md — 每次编码都要 |
| Git 提交格式规范 | CLAUDE.md 指针 → docs/git-conventions.md — 低频 + 团队共享 |
| "为什么我选了 MSI 而不是 NSIS" | Memory — 个人决策记录 |
| 初始化开发环境的完整流程 | Skill — 复杂流程，不是一条规则 |
| 发布版本的完整流程 | Skill — 同上 |
| 你对 Tailwind class 的偏好 | Memory — 个人偏好 |

---

## 7. 关键术语速查

| 术语 | 一句话定义 |
|------|-----------|
| **Skill** | 一段被注入 System Prompt 的结构化指令，定义了一个可复用的执行流程 |
| **触发词** | Description 中用于匹配用户意图的关键词，决定 Skill 何时激活 |
| **L1 Template** | 纯文本行为指令，无步骤 |
| **L2 Guided** | 有思维框架和步骤清单，但不指定工具 |
| **L3 Tooled** | 有明确步骤 + 工具调用 + 验证 ★ |
| **L4 Orchestrator** | 不包含细节，只调度其他 Skill |
| **Skill 链** | 一个 Skill 的输出作为下一个 Skill 的输入 |
| **参数化** | Skill 接受外部参数（组件名、模块路径等）|
| **降级路径** | Happy path 失败后的备用方案和人工介入点 |

---

## 8. 你的练习

```
练习 1：Skill 审计
对你现有的每个 Skill：
→ 标注它属于 L1-L4 的哪一级
→ 找出所有"只有 happy path"的地方，添加降级逻辑
→ 每个 Skill 是否有一个清晰的"完成信号"（输出文件、状态消息）？

练习 2：制作一个编排型 Skill
把 bootstrap-env + 质量门 + flashnote-publish 串成一个 release-pipeline Skill
→ 不是复制粘贴，是"引用"已有的 Skill
→ 在关键节点添加人工确认插入点
→ 为每个阶段添加失败处理

练习 3：参数化改造
把一个现有 Skill 改造为可接受参数的版本
→ 比如：bootstrap-env 接受 "--skip-python" 参数
→ 在 SKILL.md 里声明参数及其默认值
```
