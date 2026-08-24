// session/context.ts —— 上下文管理：token 预算 + 溢出 + 序列化（第 6 课 §二/三/五/六/七的纯函数层）
//
// 对应 opencode session/overflow.ts + compaction.ts 的 select/serialize + core 的 buildPrompt。
// 这里只放"纯计算"，不碰 LLM/IO；真正调压缩 agent 在 session/compaction.ts。

import type Anthropic from "@anthropic-ai/sdk";
import type { LLMConfig } from "../config/config.js";
import type { Session } from "./session.js";
import type { StoredMessage } from "./session.js";

// ── token 估算（§二的地基）──────────────────────────────────────────────
// 粗估：CJK 字符 ≈ 1 token，其余 ≈ 4 字符/token。不用 tiktoken（省依赖），够预算判定用。

export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK 统一表意
      (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
      (code >= 0x3000 && code <= 0x303f) || // CJK 标点
      (code >= 0xff00 && code <= 0xffef) // 全角字符
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return cjk + Math.ceil(other / 4);
}

export function estimateMessages(msgs: readonly Anthropic.MessageParam[]): number {
  return msgs.reduce(
    (acc, m) => acc + estimateTokens(typeof m.content === "string" ? m.content : JSON.stringify(m.content)),
    0,
  );
}

/** 整个会话当前"发出去会占多少 token"（折叠后的视角，即 §三 isOverflow 的 count） */
export function estimateSessionTokens(session: Session): number {
  return estimateMessages(session.toModelMessages());
}

// ── 预算（§二 usable）───────────────────────────────────────────────────

const RESERVED_BUFFER = 20_000; // 给输出预留的兜底（opencode COMPACTION_BUFFER）

/** 可用上下文 = 输入上限 − 预留输出空间（输出空间优先的铁律） */
export function usableTokens(cfg: LLMConfig): number {
  const limit = cfg.modelLimit;
  const reserved = Math.min(RESERVED_BUFFER, limit.maxOutputTokens);
  return Math.max(0, limit.input - reserved);
}

// ── 溢出判定（§三 isOverflow）───────────────────────────────────────────

export function isOverflow(session: Session, cfg: LLMConfig): boolean {
  const usable = usableTokens(cfg);
  if (usable <= 0) return false;
  return estimateSessionTokens(session) >= usable;
}

// ── findKeepFrom：保留最近几轮 verbatim（§五 select 的最小版）────────────

/**
 * 返回折叠边界：保留最近 2 轮 user 及其后所有消息，边界之前进摘要。
 * 少于 2 轮 → 返回 0（没得压）。
 */
export function findKeepFrom(messages: StoredMessage[]): number {
  const userIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) if (messages[i].role === "user") userIdx.push(i);
  if (userIdx.length <= 2) return 0;
  return userIdx[userIdx.length - 2];
}

// ── serialize：把消息拍平成摘要 agent 的输入文本（§六）───────────────────

const TOOL_OUTPUT_MAX_CHARS = 2_000;

export function serializeMessages(messages: StoredMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const text = msg.parts
        .filter((p): p is Extract<StoredMessage["parts"][number], { type: "text" }> => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      if (text) lines.push(`[User]: ${text}`);
      continue;
    }
    for (const part of msg.parts) {
      if (part.type === "text" && part.text) lines.push(`[Assistant]: ${part.text}`);
      else if (part.type === "reasoning" && part.text) lines.push(`[Assistant reasoning]: ${part.text}`);
      else if (part.type === "tool") {
        lines.push(`[Assistant tool call]: ${part.tool}(${JSON.stringify(part.input)})`);
        if (part.result) {
          const out =
            part.result.output.length > TOOL_OUTPUT_MAX_CHARS
              ? part.result.output.slice(0, TOOL_OUTPUT_MAX_CHARS) + "\n[truncated]"
              : part.result.output;
          lines.push(`[Tool result]: ${out}`);
        }
      }
    }
  }
  return lines.join("\n\n");
}

// ── buildSummaryPrompt：anchored summary（§七）──────────────────────────

/** 固定输出结构（移植 opencode core SUMMARY_TEMPLATE）：填空表单，机器可消费 */
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>`;

/**
 * 有 previousSummary → "更新锚定摘要"（增量）；没有 → "新建"。
 * 与 conversation 拼接后作为压缩 agent 的唯一 user 输入。
 */
export function buildSummaryPrompt(previousSummary: string | undefined, conversation: string): string {
  const instruction = previousSummary
    ? `Update the anchored summary below using the conversation history above.\nPreserve still-true details, remove stale details, and merge in the new facts.\n<previous-summary>\n${previousSummary}\n</previous-summary>`
    : "Create a new anchored summary from the conversation history.";
  return [instruction, SUMMARY_TEMPLATE, `The following is the conversation history:\n\n${conversation}`].join("\n\n");
}
