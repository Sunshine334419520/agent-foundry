# agent-foundry

从零铸造 Agent 系统。不是框架教程——是源码级理解和动手实践。

## 这是什么

一份从"用 AI 编程的人"成长为"构建 AI 系统的人"的实践路线。每个概念都不是读完就算——亲手写代码验证。

> 🗺️ **总纲**：[docs/LEARNING.md](docs/LEARNING.md) — 学习方法（理论 + opencode 精读 + TS harness 实践）
>
> 📖 **起点**：[docs/handbook.md](docs/handbook.md) — Agent Engineering 入门手册
>
> 🔬 **深度**：[docs/deep-dive/](docs/deep-dive/) — 5 篇深度实践文档
>
> 🧭 **源码精读**：[docs/opencode-study/LEARNING_MAP.md](docs/opencode-study/LEARNING_MAP.md) — OpenCode 学习地图
>
> 💻 **动手**：[demo/minimal-agent/](demo/minimal-agent/) — Python 最小 Agent ｜ [harness/](harness/) — TS Agent Harness

## 包含什么

### 文档

| # | 文档 | 主题 |
|---|------|------|
| — | [LEARNING.md](docs/LEARNING.md) | 学习方法总纲（三螺旋：理论 + opencode 精读 + harness 实践） |
| — | [opencode-study/LEARNING_MAP.md](docs/opencode-study/LEARNING_MAP.md) | OpenCode 源码精读学习地图 |
| — | [handbook.md](docs/handbook.md) | Agent Engineering 完整手册（Prompt/Skill/Memory/Planning/Tool Use） |
| 1 | [part1-prompt-and-messages.md](docs/deep-dive/part1-prompt-and-messages.md) | System Prompt / User Message / Assistant / Tool Result 的源码级解析 |
| 2 | [part2-skills.md](docs/deep-dive/part2-skills.md) | Skill 的四级进化与高级设计模式 |
| 3 | [part3-book-to-skill-analysis.md](docs/deep-dive/part3-book-to-skill-analysis.md) | 开源 Skill 架构拆解：book-to-skill |
| 4 | [part4-reverse-skill-analysis.md](docs/deep-dive/part4-reverse-skill-analysis.md) | 开源 Skill 架构拆解：reverse-skill（S 级） |
| 5 | [part5-agent-loop-demo.md](docs/deep-dive/part5-agent-loop-demo.md) | 从零构建 Agent Loop：200 行代码理解全部原理 |

### 代码

```
demo/minimal-agent/       ← Python 最小 Agent Loop（阶段 0 基础）
├── minimal_agent.py
├── requirements.txt
└── tests/

harness/                  ← 我们的 TS Agent Harness（跟着 opencode 逐阶段实现）
└── src/ (loop.ts / tools.ts / config.ts / index.ts)
```

### 案例

```
case-studies/  ← 未来放更多开源 Skill 分析
```

## 快速开始

```bash
# Python 最小 Agent：装依赖后直接跑（配置自动从 ~/.claude/settings.json 读取）
pip install anthropic
python demo/minimal-agent/minimal_agent.py "创建一个 hello.txt 文件"

# TS Agent Harness
cd harness && npm install
npx tsx src/index.ts "你的任务"
```

## 阅读顺序

```
handbook.md           ← 先读这个，建立全局认知
  ↓
part1-prompt          ← 理解 Prompt 和消息流的底层机制
  ↓
part2-skills          ← 理解 Skill 的设计模式
  ↓
part3-book-to-skill   ← 看别人怎么做（A 级 Skill）
  ↓
part4-reverse-skill   ← 看别人怎么做（S 级 Skill）
  ↓
part5-agent-loop      ← 自己动手写（核心关卡）
  ↓
LEARNING.md           ← 三螺旋：理论 + opencode 精读 + TS harness 实践
  ↓
opencode-study/LEARNING_MAP.md  ← 按地图逐阶段：精读源码 → 在 harness 实现
```

## 和其他资源的关系

| 资源 | 关系 |
|------|------|
| [Anthropic Cookbook](https://github.com/anthropics/anthropic-cookbook) | API 参考 |
| [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) | 理论补充 |
| [Agent Skills 标准](https://github.com/agentskills/agentskills) | Skill 格式规范 |
| [LangGraph](https://github.com/langchain-ai/langgraph) | Agent 框架参考（学思路，不是直接用） |

## License

MIT
