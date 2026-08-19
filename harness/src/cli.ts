// cli.ts —— UI 层：持续对话 REPL（类似 opencode / Claude Code 的终端）
//
// 只管三件事：读输入 → 调 AgentLoop.run(session) → 打印结果。
// 启动即一个 session，可连续对话，复用同一条记忆链。
// 命令：/help /clear /usage /exit；（Ctrl+C：agent 运行中=中断本轮，空闲=退出）

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Session } from "./session.js";
import { LLM } from "./llm.js";
import { AgentLoop } from "./agent-loop.js";

export async function runRepl(): Promise<void> {
  // ── 启动：亮出"实际在用什么模型 / 哪个端点"（config.ts 三层优先级的结果）──
  const llm = new LLM();
  const endpoint = llm.baseURL ? new URL(llm.baseURL).host : "(Anthropic 默认端点)";
  console.log(`▣ 模型 ${llm.model}  ·  端点 ${endpoint}`);

  const session = new Session();
  const agent = new AgentLoop(llm);
  const rl = createInterface({ input: stdin, output: stdout });

  // 当前这一轮的中断控制器；agent 空闲时为 undefined
  let activeAbort: AbortController | undefined;

  // 挂到 rl 上：readline 若注册了 'SIGINT' 监听，会覆盖它默认"关闭 interface"的行为。
  rl.on("SIGINT", () => {
    if (activeAbort) {
      activeAbort.abort();
      console.log("\n（已发送中断）");
    } else {
      console.log("\nbye");
      process.exit(0);
    }
  });

  const HELP = `命令：
  /help   显示帮助
  /clear  清空会话记忆（重新开始话题）
  /usage  显示当前记忆条数
  /exit   退出（或 Ctrl+C）
其余输入作为你的消息发给 agent。`;

  console.log("Agent Harness —— 持续对话模式（/help 看命令）\n");

  for (;;) {
    let line: string;
    try {
      line = (await rl.question("> ")).trim();
    } catch {
      break; // 输入流被关闭（Ctrl+D / EOF）
    }
    if (!line) continue;

    if (line === "/exit") break;
    if (line === "/usage") {
      console.log(`当前记忆 ${session.messageCount} 条`);
      continue;
    }
    if (line === "/help") {
      console.log(HELP);
      continue;
    }
    if (line === "/clear") {
      session.reset();
      console.log("（会话记忆已清空）");
      continue;
    }

    activeAbort = new AbortController();
    try {
      const result = await agent.run(session, line, { signal: activeAbort.signal });
      console.log(`\n${"─".repeat(60)}\n${result.text}\n${"─".repeat(60)}`);
      console.log(`记忆 ${session.messageCount} 条`);
    } finally {
      activeAbort = undefined;
    }
  }

  rl.close();
  console.log("bye");
}