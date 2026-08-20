// index.ts —— 入口：启动 REPL
// 功能目录划分（无 index 门面，一律具名文件 + 完整路径 import）：
//   config/config.ts               配置 + 定价
//   tool/tool.ts                   工具
//   llm/llm.ts · stream.ts · retry.ts   LLM 接入 + 流式折叠 + 重试
//   session/session.ts             会话存储
//   bus/event-bus.ts               事件总线
//   loop/agent-loop.ts             AgentLoop 编排（纯生产者）
//   cli/repl.ts · render.ts        UI（REPL · 消费者）
// 这里只负责点火。

import { runRepl } from "./cli/repl.js";

await runRepl();