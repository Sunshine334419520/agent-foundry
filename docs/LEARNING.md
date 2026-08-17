# Agent Harness 学习方法总纲

> 目标：从"会写 demo"到**掌握 Agent Harness 核心知识**——即 [LEARNING_MAP 课程表](opencode-study/LEARNING_MAP.md) 里的每一项（Agent Loop / Session / Agent / Tools / 上下文 / 模型 / 权限…），每项都做到**理论 + 源码 + 实现**三深。

## 三根支柱（三螺旋）

| 支柱 | 学什么 | 在哪 |
|---|---|---|
| ① 理论 | Agent 核心概念（为什么这么设计） | `docs/handbook.md` + `docs/deep-dive/` |
| ② 代码精读 | 读 opencode 源码，**让代码带我们挖出深理论** | `docs/opencode-study/LEARNING_MAP.md`（源码在 `~/code/opencode`） |
| ③ 实践 | 亲手实现我们的 Agent Harness（TS CLI） | `harness/` |

三者互相印证：**理论**讲"为什么"，**源码**讲"生产怎么做"，**harness** 讲"我真的会了"。

## 方法论基石：以代码为大纲，理论从代码中挖出

- 阶段 1 的理论只是**子集**，生产代码是**全集**——不要用旧理论去框代码，会漏掉大量新理论。
- 每个核心知识（Agent Loop、Session 管理……）都是一次**独立深挖**：通读源码 → 识别它涉及的核心理论 → 逐个深入 → 落文档 → 在 harness 实现。
- **理论是终点，代码是途径**——两者是一件事，不是两件事。

## 阅读路径

1. **基础**（已完成）：`handbook.md` → `deep-dive/` part1-5 → 亲手写 Python 最小 Agent（`demo/minimal-agent/`）。
2. **主线**：打开 `opencode-study/LEARNING_MAP.md` 的**核心知识清单**，从 #1 开始逐项深挖：理论 → 源码 → harness 实现 → 笔记。
3. **每单元验收**：能讲清该核心知识的"为什么" + harness 里对应层能跑 + 笔记落档。

## 为什么是"三螺旋"

单一方式都学不扎实：只看理论会"眼高手低"，只读源码容易"被带跑"，只写代码会"知其然不知其所以然"。三者交替推进——每学一块，都在另外两根柱子上得到印证。
