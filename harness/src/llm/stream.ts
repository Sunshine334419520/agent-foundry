// llm/stream.ts —— 纯折叠消费者：把语义流事件归并成一条完整回复
//
// 学 opencode packages/llm/src/schema/events.ts 的 reduceResponseState：
//   (state, event) => newState 的纯 reduce——无副作用、可单测、与 UI 渲染解耦。
// 与 render.ts（副作用消费者）是"一条流，两个消费者"的同一原则：
//   这边负责"把事件变成数据"，那边负责"把事件画出来"。
// 注意：推理(tool-input/reasoning)增量事件与"回复组装"无关，折叠时忽略——它们只给渲染用。

import Anthropic from "@anthropic-ai/sdk";
import type { StreamEvent, Usage } from "./llm.js";

export interface StreamState {
  /** 已闭合的内容块（text / tool_use），直接交给 session / 最终文本 */
  blocks: Anthropic.ContentBlockParam[];
  /** 正在累积的文本块（text-start 打开，text-end 闭合进 blocks） */
  currentText?: string;
  stopReason: string | undefined;
  usage: Usage;
  finished: boolean;
}

export const initialStreamState = (): StreamState => ({
  blocks: [],
  stopReason: undefined,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  finished: false,
});

/** 纯折叠：喂一个事件、出一个新 state。不改动入参。 */
export function reduceStream(state: StreamState, event: StreamEvent): StreamState {
  switch (event.type) {
    case "text-start":
      return { ...state, currentText: "" };
    case "text-delta":
      return { ...state, currentText: (state.currentText ?? "") + event.text };
    case "text-end":
      return {
        ...state,
        currentText: undefined,
        blocks: [...state.blocks, { type: "text", text: state.currentText ?? "" }],
      };
    case "tool-call":
      // 参数已在 llm.ts 解析成对象；这里直接成块
      return {
        ...state,
        blocks: [
          ...state.blocks,
          { type: "tool_use", id: event.callID, name: event.name, input: event.input },
        ],
      };
    case "finish":
      return { ...state, stopReason: event.stopReason, usage: event.usage, finished: true };
    default:
      // reasoning-* / tool-input-* 只服务渲染，折叠忽略
      return state;
  }
}

/** 从折叠结果取最终正文（所有 text 块拼接）。 */
export function finalText(state: StreamState): string {
  return state.blocks
    .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** 是否还有待执行的工具调用（双传感器之一）。 */
export function hasToolCalls(state: StreamState): boolean {
  return state.blocks.some((b) => b.type === "tool_use");
}