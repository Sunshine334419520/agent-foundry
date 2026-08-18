// loop.ts —— Agent Loop 心脏（学习地图 第 1 课深挖版）
//
// 从 opencode 学到的（对照 D:\code\opencode\packages\opencode\src\session\）：
//   1. 驱动器分离：runLoop（外层，管"继续与否"）↔ oneStep（单步，一次 LLM 往返 + 工具执行）
//                  对照 prompt.ts 的 runLoop ↔ processor.ts 的 process
//   2. 停止条件：finish = response.stop_reason + 挂起工具 双传感器
//                  对照 prompt.ts:1100-1130 的四个 AND（去掉持久化相关的 parentID）
//   3. maxSteps 软限制：到步数不是硬 break，而是尾部塞一条收尾 prefill 让模型自己收敛
//                  对照 prompt.ts:1278-1282 + max-steps.ts
//   4. 错误分层：callWithRetry（可重试退避）→ halt（不可重试落 error）→ cleanup（收尾）
//                  对照 processor.ts:647-677
// 刻意不做（留给后续课）：数据库持久化(#13)、流式(#7)、SDK 工具自执行(#5)、
//                  溢出压缩(#6 仅占位)、doom-loop 权限询问(#8)。

import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "./config.js";
import { TOOLS, executeTool } from "./tools.js";
import { retryable, delay, RETRY_MAX_RETRIES } from "./retry.js";

const SYSTEM_PROMPT = `You are an AI coding agent. You have access to tools for reading/writing files and running commands.
Work step by step. Read files before editing them. When the task is done, call the finish tool.
Be precise and careful with file operations.`;

// 收尾指令 —— 借鉴 opencode max-steps.ts：到步数上限时让模型自己收尾，而不是硬切断。
// 以 role:"assistant" 尾条 prefill 注入，模型顺着这段"它自己已说的话"继续，自洽性推它服从。
const MAX_STEPS_PROMPT = `CRITICAL - MAXIMUM STEPS REACHED
The maximum number of steps for this task has been reached. Do NOT call any tools.
Provide a concise final response: what was accomplished, what remains, and what you'd do next.`;

type StepOutcome = { action: "stop" | "continue"; text: string };

/**
 * 单步：一次 LLM 往返 + 工具执行。
 * 对应 opencode processor.process + handleEvent 的同步化简化：
 *   - 请求构建（含收尾 prefill）
 *   - callWithRetry 调 LLM（可重试退避）
 *   - 用 stop_reason + 是否有 tool_use 决定"这轮是否收尾"（停止条件双传感器）
 *   - 有工具调用就执行并把结果回喂，返回 continue
 */
async function oneStep(
  client: Anthropic,
  cfg: ReturnType<typeof loadConfig>,
  messages: Anthropic.MessageParam[],
  step: number,
  maxSteps: number,
): Promise<StepOutcome> {
  const isLastStep = step >= maxSteps;

  // ── 请求构建，对照 prompt.ts:1257-1286 ──
  // 尾部拼收尾 prefill（prompt.ts:1278-1282），仅当次请求、不写进持久化 messages。
  const requestMessages: Anthropic.MessageParam[] = [
    ...messages,
    ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS_PROMPT }] : []),
  ];

  // ── 调 LLM：可重试错误自动退避（processor.ts:660-674 的 Effect.retry）──
  const response = await callWithRetry(() =>
    client.messages.create({
      model: cfg.model,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: requestMessages,
      tools: TOOLS,
    }),
  );

  // 把 assistant 整段回复记进记忆（保留 text / tool_use / thinking 块）
  messages.push({ role: "assistant", content: response.content });

  // ── 停止条件：双传感器（prompt.ts:1104-1130）──
  //   传感器① finish = stop_reason；传感器② content 里有没有 tool_use
  //   只要"还想调工具"就继续，即使 provider 返回了别的 finish（opencode 明确踩过这个坑）。
  const finish = response.stop_reason ?? "unknown";
  const isToolUse = (b: Anthropic.ContentBlock): b is Anthropic.ToolUseBlock => b.type === "tool_use";
  const toolUses = response.content.filter(isToolUse);
  const hasTools = toolUses.length > 0;

  if (finish === "tool_use" || hasTools) {
    // 执行工具 —— 我们的代码在干活，模型只"说要做什么"
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    console.log(`  Tool calls: ${toolUses.map((t) => t.name).join(", ")}`);
    for (const tu of toolUses) {
      console.log(`    → ${tu.name}(${JSON.stringify(tu.input)})`);
      const result = executeTool(tu.name, tu.input as Record<string, unknown>);
      console.log(`    ← ${result.slice(0, 120)}${result.length > 120 ? "…" : ""}`);
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
    }
    // 工具结果作为 user 消息回喂（对应"记忆"里追新 user）
    messages.push({ role: "user", content: toolResults });
    return { action: "continue", text: "" };
  }

  // 没有工具调用 → 这轮收尾（end_turn / max_tokens / refusal … 都算"答完了"）
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return { action: "stop", text };
}

/** 可重试调用：分类（retry.ts retryable）+ 指数退避（retry.ts delay）。耗尽或不可重试则抛出。 */
async function callWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= RETRY_MAX_RETRIES || !retryable(err)) throw err; // 不可重试/耗尽 → 抛给 halt
      attempt++;
      const wait = await delay(attempt, err);
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ⚠️  attempt ${attempt}/${RETRY_MAX_RETRIES} failed: ${msg} — retrying in ${wait}ms`);
    }
  }
}

/**
 * 驱动器：外层 while(true)，管"继续与否"。
 * 对应 opencode runLoop（prompt.ts:1081-1341）的同步版。停止时返回最终文本。
 */
export async function agentLoop(task: string, maxSteps = 30): Promise<string> {
  const cfg = loadConfig();
  const client = new Anthropic({ baseURL: cfg.baseURL, authToken: cfg.authToken });
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];

  try {
    // 上限只是一个防病态死循环的背板（比如模型死活不收敛）；正常靠停止条件自然退出，
    // 到 maxSteps 靠收尾 prefill 让模型自己收尾，而不是硬切断。
    for (let step = 0; step < 10_000; step++) {
      console.log(`\n${"=".repeat(60)}\nStep ${step + 1}`);

      const { action, text } = await oneStep(client, cfg, messages, step, maxSteps);
      if (action === "stop") {
        console.log(`\nAgent finished (step ${step + 1}):\n${text}`);
        return text;
      }

      // ── overflow 占位（第 6 课上下文管理）──
      // 这里未来应接入：估算 messages 的 token → 超预算时先压缩（保留首条 user + 近 N 条），
      // 再 continue，而不是一路把上下文堆到被 API 拒绝 —— 对应 opencode overflow.ts / compaction.ts。
    }
  } catch (err) {
    // ── halt（processor.ts:599-625）：重试耗尽 / 不可重试 → 落 error，不静默吞 ──
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n[halt] agent 出错停止: ${message}`);
    return `[error] ${message}`;
  } finally {
    // ── cleanup（processor.ts:539-597）──
    // 同步模型里没有"在飞工具"要标记，cleanup 退化为幂等收尾；保留分层结构作占位。
    // 将来若接 SDK 流式工具执行，这里要像 opencode 一样：给仍 running 的在飞工具
    // 补 end 时间 / 标 interrupted:true，避免被误当作待办。
  }

  return "Agent reached max steps without finishing.";
}