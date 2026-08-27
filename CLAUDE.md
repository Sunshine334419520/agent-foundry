# agent-foundry —— 项目说明

本仓库有两个并行的主线，操作时先确认你在做哪条线：

## 1. opencode 学习 + harness 实现

- **学习地图**：`docs/opencode-study/LEARNING_MAP.md`（课程表 + 五步推进法）
- **harness 代码**：`harness/src/`（TypeScript agent harness，对照 opencode 源码重实现）
- **配套源码**：`~/code/opencode`（opencode 稀疏克隆）
- 学习方法论：以代码为大纲，理论从源码挖出；五步推进法（A 理论 → B 讨论 → C 精读 → D 实现 → E 验收），常跳过 B。

## 2. 小红书专栏《AI 是怎么干活的》

- **选题表**：`docs/xiaohongshu/01-选题表.md`（每篇的选题、图文分镜、生成提示词）
- **专栏总纲**：`docs/xiaohongshu/00-专栏总纲.md`
- **⚡ 图片生成规范（必读）**：`docs/xiaohongshu/图片生成规范.md` —— 涉及 `docs/xiaohongshu/` 目录时**必须先读**本文件再动手。核心：信息图/架构图统一浅色架构图风；所有文字统一 marker-pen 手写笔触；提示词三段式（中英对照/中文/EN）；生成用 imini（`~/.claude/skills/imini-generate`），参考图与产出图存 `docs/xiaohongshu/assets/`。
- **参考素材**：`docs/zhihu.md`（Harness 领域前沿概念底稿）
