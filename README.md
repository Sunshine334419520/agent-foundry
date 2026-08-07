# agent-foundry

从零铸造 Agent 系统。不是框架教程——是源码级理解和动手实践。

## 这是什么

一份从"用 AI 编程的人"成长为"构建 AI 系统的人"的实践路线。每个概念都不是读完就算——亲手写代码验证。

> 📖 **起点**：[docs/handbook.md](docs/handbook.md) — Agent Engineering 入门手册
>
> 🔬 **深度**：[docs/deep-dive/](docs/deep-dive/) — 5 篇深度实践文档
>
> 💻 **动手**：[demo/minimal-agent/](demo/minimal-agent/) — 200 行最小 Agent Loop

## 包含什么

### 文档

| # | 文档 | 主题 |
|---|------|------|
| — | [handbook.md](docs/handbook.md) | Agent Engineering 完整手册（Prompt/Skill/Memory/Planning/Tool Use） |
| 1 | [part1-prompt-and-messages.md](docs/deep-dive/part1-prompt-and-messages.md) | System Prompt / User Message / Assistant / Tool Result 的源码级解析 |
| 2 | [part2-skills.md](docs/deep-dive/part2-skills.md) | Skill 的四级进化与高级设计模式 |
| 3 | [part3-book-to-skill-analysis.md](docs/deep-dive/part3-book-to-skill-analysis.md) | 开源 Skill 架构拆解：book-to-skill |
| 4 | [part4-reverse-skill-analysis.md](docs/deep-dive/part4-reverse-skill-analysis.md) | 开源 Skill 架构拆解：reverse-skill（S 级） |
| 5 | [part5-agent-loop-demo.md](docs/deep-dive/part5-agent-loop-demo.md) | 从零构建 Agent Loop：200 行代码理解全部原理 |

### 代码

```
demo/minimal-agent/
├── minimal_agent.py      ← 最小 Agent Loop（可直接运行）
├── requirements.txt
└── tests/
```

### 案例

```
case-studies/  ← 未来放更多开源 Skill 分析
```

## 快速开始

```bash
# 安装依赖
pip install anthropic

# 设置 API Key
export ANTHROPIC_API_KEY="sk-ant-..."

# 跑第一个 Agent
python demo/minimal-agent/minimal_agent.py "创建一个 hello.txt 文件"

# 跑测试
python demo/minimal-agent/minimal_agent.py --test
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
