// llm.ts —— 能力层：LLM 客户端封装
//
// 对应 opencode session/llm.ts。封装 new Anthropic + generate() + 用量统计 + 重试。
// 编排层（agent-loop.ts）不碰 SDK，只跟这层打交道。

import Anthropic from "@anthropic-ai/sdk";
import { loadConfig, type LLMConfig } from "./config.js";
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