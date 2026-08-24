// cli/repl.ts —— UI 层：持续对话 REPL（类似 opencode / Claude Code 的终端）
//
// 只管三件事：读输入 → 调 AgentLoop.run(session) → 打印结果。
// 启动即一个 session，可连续对话，复用同一条记忆链。
// 命令：/help /clear /usage /exit；（Ctrl+C：agent 运行中=中断本轮，空闲=退出）

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Session } from "../session/session.js";
import { LLM } from "../llm/llm.js";
import { AgentLoop } from "../loop/agent-loop.js";
import { getAgent, listAgents } from "../agent/agent.js";
import { compact } from "../session/compaction.js";
import { loadConfig } from "../config/config.js";
import { bus } from "../bus/event-bus.js";
import { ReplRenderer } from "./render.js";

export async function runRepl(): Promise<void> {
  // ── 组合根：把"消费者"挂到总线上。agent-loop 是生产者，不关心谁在听。──
  const renderer = new ReplRenderer();
  bus.on((event) => renderer.on(event));

  // ── 启动：亮出"实际在用什么模型 / 哪个端点"（config.ts 三层优先级的结果）──
  const llm = new LLM();
  const endpoint = llm.baseURL ? new URL(llm.baseURL).host : "(Anthropic 默认端点)";
  console.log(`▣ 模型 ${llm.model}  ·  端点 ${endpoint}`);

  const session = new Session();
  const agent = new AgentLoop(llm);
  const rl = createInterface({ input: stdin, output: stdout });

  // 当前这一轮的中断控制器；agent 空闲时为 undefined
  let activeAbort: AbortController | undefined;

  // 学习日志开关：默认开——把"发给 AI 的完整请求 / AI 返回 / 摘要过程"打出来
  let verbose = true;

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
  /help          显示帮助
  /agent         显示当前 agent 与全部可选 agent
  /agent <名字>  切换 agent（第 3 课：换人设+换权限）
  /compact       手动压缩上下文（第 6 课：保留最近 2 轮，旧上下文压成锚定摘要）
  /verbose       切换学习日志（完整请求/AI 返回/摘要过程）
  /clear         清空会话记忆（重新开始话题）
  /usage         显示当前记忆条数
  /exit          退出（或 Ctrl+C）
其余输入作为你的消息发给当前 agent。`;

  console.log(
    `Agent Harness —— 持续对话模式（/help 看命令）\n▣ agent: ${session.agent}（/agent 切换）· 学习日志 ${verbose ? "ON" : "OFF"}（/verbose）\n`,
  );

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
    // 第 3 课：/agent 列出 & 切换。校验放前面（getAgent 抛错），切换交给 session.setAgent。
    if (line === "/agent") {
      console.log(`当前 agent：${session.agent}`);
      for (const a of listAgents().filter((x) => !x.hidden)) {
        const marker = a.name === session.agent ? " ◂" : "";
        console.log(`  ${a.name.padEnd(8)} ${a.description}${marker}`);
      }
      continue;
    }
    if (line.startsWith("/agent ")) {
      const name = line.slice("/agent ".length).trim();
      try {
        const target = getAgent(name); // 校验存在（不存在会抛错）
        if (target.hidden) {
          console.log(`agent "${name}" 是内部 agent，不可选（可用：${listAgents().filter((a) => !a.hidden).map((a) => a.name).join(" / ")}）`);
          continue;
        }
        session.setAgent(name);
        console.log(`→ 已切换到 agent：${name}（${target.description}）`);
      } catch {
        console.log(`未知 agent "${name}"。可用：${listAgents().filter((a) => !a.hidden).map((a) => a.name).join(" / ")}`);
      }
      continue;
    }
    if (line === "/compact") {
      // 第 6 课：手动压缩（无视溢出判定，强制触发；学习日志强开观察摘要过程）
      if (session.messageCount < 3) {
        console.log("（消息不足 2 轮，无需压缩）");
        continue;
      }
      await compact(llm, session, loadConfig(), true);
      console.log(`📦 已压缩：摘要为——\n${session.summaryText ?? "（空）"}`);
      continue;
    }
    if (line === "/verbose") {
      verbose = !verbose;
      console.log(`学习日志：${verbose ? "ON —— 会打印完整请求/AI 返回/摘要过程" : "OFF"}`);
      continue;
    }

    activeAbort = new AbortController();
    try {
      const result = await agent.run(session, line, { signal: activeAbort.signal, verbose });
      console.log(`\n${"─".repeat(60)}\n[${session.agent}] ${result.text}\n${"─".repeat(60)}`);
      if (result.truncated) console.log("⚠️ 输出在 max_tokens 处被截断");
      console.log(`记忆 ${session.messageCount} 条`);
    } finally {
      activeAbort = undefined;
    }
  }

  rl.close();
  console.log("bye");
}