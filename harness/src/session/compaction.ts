// session/compaction.ts —— 压缩编排（第 6 课 §四 的落地）
//
// 对应 opencode compaction.ts 的 create/process 最小版：
//   maybeCompact：溢出 → 压；不溢出 → 不动（agent-loop 每轮组装前调用）
//   compact：决定折叠边界（保留最近 2 轮 verbatim）→ 序列化旧段 → 调 compaction agent
//            → 存摘要 + 折叠偏移（Session.setSummary）
// 压缩 agent 复用第 3 课的 Agent 机制（getAgent("compaction")，hidden + tools: []）。

import type Anthropic from "@anthropic-ai/sdk";
import type { LLM } from "../llm/llm.js";
import type { LLMConfig } from "../config/config.js";
import { getAgent } from "../agent/agent.js";
import { bus } from "../bus/event-bus.js";
import { Session } from "./session.js";
import { buildSummaryPrompt, findKeepFrom, isOverflow, serializeMessages } from "./context.js";

/** 压缩调用只需要 generate（agent-loop 的完整 LLM 满足它；测试可传 mock） */
type SummaryLLM = Pick<LLM, "generate">;

/**
 * 溢出检测 + 压缩，一步到位。返回是否真的发生了压缩。
 * agent-loop 每轮组装上下文前调用；没溢出就零开销返回 false。
 */
export async function maybeCompact(
  llm: SummaryLLM,
  session: Session,
  cfg: LLMConfig,
  verbose = false,
): Promise<boolean> {
  if (!isOverflow(session, cfg)) return false;
  await compact(llm, session, cfg, verbose);
  return true;
}

/** 执行压缩：保留最近 2 轮 verbatim，其余交给摘要 agent 压成锚定摘要。 */
export async function compact(llm: SummaryLLM, session: Session, cfg: LLMConfig, verbose = false): Promise<void> {
  const all = session.allMessages;
  const keepFrom = findKeepFrom(all);
  if (keepFrom <= 0) return; // 少于 2 轮，没得压
  const head = all.slice(0, keepFrom);
  if (head.length === 0) return;

  const previousSummary = session.summaryText; // anchored：上次摘要
  const conversation = serializeMessages(head);
  const summary = await runSummaryAgent(llm, cfg, previousSummary, conversation, verbose);
  session.setSummary(summary, keepFrom);
}

/** 调 compaction agent：system = agent.prompt，user = buildSummaryPrompt（含模板 + 历史）。 */
async function runSummaryAgent(
  llm: SummaryLLM,
  _cfg: LLMConfig,
  previousSummary: string | undefined,
  conversation: string,
  verbose: boolean,
): Promise<string> {
  const agent = getAgent("compaction");
  const prompt = buildSummaryPrompt(previousSummary, conversation);
  if (verbose) {
    // 学习日志：摘要 prompt（压缩 agent 人设 + anchored 指令 + 历史）
    bus.emit({
      type: "debug",
      label: "compaction · 摘要 prompt",
      content: `【system：compaction agent】\n${agent.prompt}\n\n【user】\n${prompt}`,
    });
  }
  const res = await llm.generate({
    system: agent.prompt,
    messages: [{ role: "user", content: prompt }],
    tools: [],
  });
  // 摘要 agent 只该吐文本；取全部 text 块拼起来（防御性）
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim() || "(摘要为空)";
  if (verbose) {
    // 学习日志：摘要结果 + 折叠边界
    bus.emit({ type: "debug", label: "compaction · 摘要结果", content: text });
  }
  return text;
}
