// llm/llm.ts —— 能力层：LLM 客户端封装
//
// 对应 opencode session/llm.ts。封装 new Anthropic + generate() + 用量统计 + 重试。
// 编排层（agent-loop.ts）不碰 SDK，只跟这层打交道。

import Anthropic from "@anthropic-ai/sdk";
import { loadConfig, type LLMConfig } from "../config/config.js";
import { retryable, delay, RETRY_MAX_RETRIES } from "./retry.js";

/** 一次 API 调用的 token 用量（字段来自 SDK Message.usage，null 归一为 0） */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface LLMGenerateInput {
  system: string;
  messages: readonly Anthropic.MessageParam[];
  tools: readonly Anthropic.Tool[];
  signal?: AbortSignal;
}

export interface LLMResponse {
  content: Anthropic.ContentBlock[];
  stopReason: string | undefined;
  usage: Usage;
}

/**
 * 语义流事件：把 Anthropic SSE 字节流归一化成 opencode LLMEvent 的最小版。
 * 对应 opencode packages/llm/src/schema/events.ts 的 16 种事件（我们保留核心子集）。
 * 增量事件（text/reasoning/tool-input 的 delta）必须靠调用方累积——状态属于整股流。
 */
export type StreamEvent =
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; text: string }
  | { type: "text-end"; id: string }
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; text: string }
  | { type: "reasoning-end"; id: string }
  | { type: "tool-input-start"; callID: string; name: string }
  | { type: "tool-input-delta"; callID: string; text: string }
  | { type: "tool-input-end"; callID: string }
  | { type: "tool-call"; callID: string; name: string; input: unknown } // 参数已在 stop 时解析
  | { type: "finish"; stopReason: string | undefined; usage: Usage }; // 流结束（正常路径必有）

export class LLM {
  /** 实际生效的模型名（方便 UI 每一步显示） */
  readonly model: string;
  /** 端点（不含 token，方便 UI 显示"我从哪来"） */
  readonly baseURL: string | undefined;
  private readonly client: Anthropic;

  constructor(cfg: LLMConfig = loadConfig()) {
    this.model = cfg.model;
    this.baseURL = cfg.baseURL;
    this.client = new Anthropic({ baseURL: cfg.baseURL, authToken: cfg.authToken });
  }

  /** 单次生成：内部完成可重试退避，返回结构化回复 + 用量。 */
  async generate(input: LLMGenerateInput): Promise<LLMResponse> {
    const message = await this.callWithRetry(() =>
      this.client.messages.create(
        {
          model: this.model,
          max_tokens: 8192,
          system: input.system,
          // SDK 参数要求可变数组；Session 给的是只读视图，运行时不修改，可选转换。
          messages: input.messages as Anthropic.MessageParam[],
          tools: input.tools as Anthropic.Tool[],
        },
        { signal: input.signal }, // signal 属于 RequestOptions，用于中断
      ),
    );

    const u = message.usage;
    return {
      content: message.content,
      stopReason: message.stop_reason ?? undefined,
      usage: {
        input: u?.input_tokens ?? 0,
        output: u?.output_tokens ?? 0,
        cacheRead: u?.cache_read_input_tokens ?? 0,
        cacheWrite: u?.cache_creation_input_tokens ?? 0,
      },
    };
  }

  /**
   * 流式生成：把 Anthropic SSE（RawMessageStreamEvent）逐事件归一成语义事件。
   * 对应 opencode LLM.stream + LLMAISDK.toLLMEvents（llm.ts:357-381 / llm/ai-sdk.ts）。
   * 结束时必发 `finish`（携带 stopReason + 累计用量）；中途 SDK 报错则抛出（交给上层 halt）。
   */
  async *stream(input: LLMGenerateInput): AsyncGenerator<StreamEvent> {
    // ── 跨事件状态（opencode adapterState 的意图：delta 事件需要累积上下文）──
    // 按 content block index 记录正在构建的块
    const blocks = new Map<number, { kind: "text" | "reasoning" | "tool"; id: string; name?: string; json?: string }>();
    let textSeq = 0;
    let reasoningSeq = 0;
    let toolSeq = 0;
    let stopReason: string | undefined;
    const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

    const raw = await this.callWithRetry(() =>
      this.client.messages.create(
        {
          model: this.model,
          max_tokens: 8192,
          system: input.system,
          messages: input.messages as Anthropic.MessageParam[],
          tools: input.tools as Anthropic.Tool[],
          stream: true,
        },
        { signal: input.signal },
      ),
    );

    for await (const event of raw) {
      switch (event.type) {
        case "message_start": {
          const u = event.message.usage;
          usage.cacheRead = u?.cache_read_input_tokens ?? 0;
          usage.cacheWrite = u?.cache_creation_input_tokens ?? 0;
          usage.input = (u?.input_tokens ?? 0) - usage.cacheRead - usage.cacheWrite;
          break;
        }
        case "content_block_start": {
          // 块开始 = 声明（对应 opencode 的 *-start 事件）
          const b = event.content_block;
          if (b.type === "text") {
            const id = `text-${textSeq++}`;
            blocks.set(event.index, { kind: "text", id });
            yield { type: "text-start", id };
          } else if (b.type === "tool_use") {
            const id = `tool-${toolSeq++}`;
            blocks.set(event.index, { kind: "tool", id, name: b.name, json: "" });
            yield { type: "tool-input-start", callID: id, name: b.name };
          } else if (b.type === "thinking") {
            const id = `reasoning-${reasoningSeq++}`;
            blocks.set(event.index, { kind: "reasoning", id });
            yield { type: "reasoning-start", id };
          }
          break;
        }
        case "content_block_delta": {
          // 增量 = 内容到达（对应 *-delta 事件）
          const st = blocks.get(event.index);
          if (!st) break;
          if (st.kind === "text" && event.delta.type === "text_delta")
            yield { type: "text-delta", id: st.id, text: event.delta.text };
          else if (st.kind === "reasoning" && event.delta.type === "thinking_delta")
            yield { type: "reasoning-delta", id: st.id, text: event.delta.thinking };
          else if (st.kind === "tool" && event.delta.type === "input_json_delta") {
            st.json = (st.json ?? "") + event.delta.partial_json;
            yield { type: "tool-input-delta", callID: st.id, text: event.delta.partial_json };
          }
          break;
        }
        case "content_block_stop": {
          // 块收尾 = 终结（对应 *-end / tool-call 事件）
          const st = blocks.get(event.index);
          if (!st) break;
          if (st.kind === "tool") {
            yield { type: "tool-input-end", callID: st.id };
            let input: unknown = {};
            try {
              input = st.json ? JSON.parse(st.json) : {};
            } catch {
              input = { raw: st.json }; // 半截 JSON 兜底（如中断时的参数）
            }
            yield {
              type: "tool-call",
              callID: st.id,
              name: st.name ?? "unknown",
              input,
            };
          } else if (st.kind === "text") {
            yield { type: "text-end", id: st.id };
          } else {
            yield { type: "reasoning-end", id: st.id };
          }
          blocks.delete(event.index);
          break;
        }
        case "message_delta": {
          // 到这里 stop_reason 才出现（正文结束的信号），用量随 delta 到达
          if (event.delta.stop_reason) stopReason = event.delta.stop_reason;
          const u = event.usage;
          if (u) {
            usage.output += u.output_tokens ?? 0;
            // 部分端点只在 message_delta 报 input：作兜底更新（Anthropic 语义下 input 不含缓存）
            if (u.input_tokens) usage.input = (u.input_tokens ?? 0) - usage.cacheRead - usage.cacheWrite;
          }
          break;
        }
        case "message_stop": {
          yield { type: "finish", stopReason, usage };
          return;
        }
        default: {
          // SDK 类型未枚举的运行时事件（例如 provider 报错）统一兜底，避免静默吞掉
          const raw = event as { type?: string; error?: unknown };
          if (raw.type === "error")
            throw new Error(`provider stream error: ${raw.error instanceof Error ? raw.error.message : String(raw.error)}`);
          break;
        }
      }
    }
    // 理论永不达（message_stop 必到）；防御性兜底，保证消费者总能收到 finish
    yield { type: "finish", stopReason, usage };
  }

  /** 可重试调用：分类（retryable）+ 指数退避（delay）。耗尽或不可重试则抛出（交给上层 halt）。 */
  private async callWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (attempt >= RETRY_MAX_RETRIES || !retryable(err)) throw err;
        attempt++;
        const wait = await delay(attempt, err);
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ⚠️  attempt ${attempt}/${RETRY_MAX_RETRIES} failed: ${msg} — retrying in ${wait}ms`);
      }
    }
  }
}