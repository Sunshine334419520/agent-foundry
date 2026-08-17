// loop.ts —— Agent Loop 心脏（学习地图 阶段 1）
//
// 5 步循环：记忆 → 问一次 LLM → 它要不要动手？ → 动手 / 收尾 → 循环。
// 与 Python demo 的 agent_loop 一一对应，只是换成了 TS + Anthropic SDK。

import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "./config.js";
import { TOOLS, executeTool } from "./tools.js";

const SYSTEM_PROMPT = `You are an AI coding agent. You have access to tools for reading/writing files and running commands.
Work step by step. Read files before editing them. When the task is done, call the finish tool.
Be precise and careful with file operations.`;

export async function agentLoop(task: string, maxSteps = 30): Promise<string> {
  const cfg = loadConfig();
  const client = new Anthropic({
    baseURL: cfg.baseURL,
    authToken: cfg.authToken,
  });

  // ⭐ 记忆：整个 Agent 的状态只有这一个数组（对应 opencode 的 session/message.ts）
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];

  for (let step = 0; step < maxSteps; step++) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Step ${step + 1}/${maxSteps}`);

    // --- 1. 问一次 LLM（HTTP POST 的化身）---
    const response = await client.messages.create({
      model: cfg.model,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages,
      tools: TOOLS,
    });

    // --- 2. 把整个回复记进记忆（保留 tool_use / thinking 块）---
    messages.push({ role: "assistant", content: response.content });

    // --- 3. 看它想不想动手 ---
    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      const finalText = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      console.log(`\nAgent finished:\n${finalText}`);
      return finalText;
    }

    // --- 4. 逐个执行（我们的代码在干活）---
    console.log(`Tool calls: ${toolUses.map((t) => t.name).join(", ")}`);
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      console.log(`  → ${tu.name}(${JSON.stringify(tu.input)})`);
      // SDK 里 tool_use.input 类型是 unknown，工具执行器要求 Record<string, unknown>
      const result = executeTool(tu.name, tu.input as Record<string, unknown>);
      console.log(`  ← ${result.slice(0, 150)}...`);
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
    }

    // --- 5. 把工具结果"假装成用户的话"塞回记忆 ---
    messages.push({ role: "user", content: toolResults });
  }

  return "Agent reached max steps without finishing.";
}
