// index.ts —— 入口：启动 REPL
// 所有分层都在 src/ 里：config(能力) · retry(能力) · tools(能力) · llm(能力)
//    · session(数据) · agent-loop(编排) · cli(UI)。这里只负责点火。

import { runRepl } from "./cli.js";

await runRepl();