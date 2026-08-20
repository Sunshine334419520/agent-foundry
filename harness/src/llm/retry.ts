// llm/retry.ts —— 可重试判断 + 指数退避（第 1 课错误分层：retry 这一层）
//
// 移植 opencode 的思想（对照 D:\code\opencode\packages\opencode\src\session\retry.ts）：
//   - retryable(): 哪些错误值得重试。opencode 的哲学：可重试的绝不放弃，
//     不可重试的（如上下文溢出、用户中断）绝不瞎重试。
//   - delay(): 指数退避 + 抖动，尊重服务端的 Retry-After 节流信号。
// 精简版只保留"网络 / 限流 / 5xx / 错误消息模式"几类可重试条件。

import Anthropic from "@anthropic-ai/sdk";

// 可重试的错误消息特征（借鉴 opencode RETRYABLE_MESSAGE_PATTERNS，精简）
const RETRYABLE_PATTERNS = [
  /rate.?limit|too many requests|overloaded|service unavailable|internal error|server error/i,
  /failed to fetch|network error|connection (error|refused|reset|lost)|socket hang up|ec(onnrefused|onnreset|timedout)/i,
  /(request|response|connection|network|stream|read).*(timeout|timed out|timedout)/i,
  /try (again|your request again)|resource exhausted|429|500|502|503|504/i,
];

export const RETRY_MAX_RETRIES = 5; // opencode 同款上限
export const RETRY_INITIAL_DELAY = 2000; // base（ms）
export const RETRY_BACKOFF_FACTOR = 2; // 2^n 退避
export const RETRY_JITTER_FACTOR = 0.25; // ±25% 抖动
export const RETRY_MAX_DELAY = 30_000; // 单次等待上限（ms）

/** 这个错误值得重试吗？opencode retry.ts:84-154 的精简版。 */
export function retryable(err: unknown): boolean {
  // 用户主动中断、程序断点 —— 永远不重试
  if (err instanceof Anthropic.APIUserAbortError) return false;

  // 网络层失败（fetch failed、连接拒绝…）—— 典型瞬时，值得重试
  if (err instanceof Anthropic.APIConnectionError) return true;

  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    // 429 限流、5xx 服务端瞬时故障 —— 一律可重试（opencode 对 5xx 的处理）
    if (err instanceof Anthropic.RateLimitError) return true;
    if (status !== undefined && status >= 500) return true;
    // 其它 4xx：再看错误消息里有没有"可重试"暗示
    return matchesRetryable(err.message);
  }

  // 非 Anthropic 错误（如超时抛的普通 Error）：看消息文本
  const message = err instanceof Error ? err.message : String(err);
  return matchesRetryable(message);
}

function matchesRetryable(value: unknown): boolean {
  return typeof value === "string" && RETRYABLE_PATTERNS.some((p) => p.test(value));
}

/**
 * 计算并 sleep 这次重试要等多久，返回实际等待的毫秒数。
 * 尊重 Retry-After / Retry-After-Ms 头（opencode retry.ts:46-77），否则指数退避。
 */
export async function delay(attempt: number, err?: unknown): Promise<number> {
  let ms = exponentialBackoff(attempt);

  const retryAfterMs = readHeader(err, "retry-after-ms");
  if (retryAfterMs) {
    const parsed = Number.parseFloat(retryAfterMs);
    if (!Number.isNaN(parsed)) ms = Math.min(parsed, RETRY_MAX_DELAY);
  } else {
    const retryAfter = readHeader(err, "retry-after"); // 单位：秒
    if (retryAfter) {
      const parsed = Number.parseFloat(retryAfter);
      if (!Number.isNaN(parsed)) ms = Math.min(parsed * 1000, RETRY_MAX_DELAY);
    }
  }

  await new Promise((resolve) => setTimeout(resolve, ms));
  return ms;
}

function exponentialBackoff(attempt: number): number {
  const base = RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1);
  return Math.min(Math.ceil(base + base * RETRY_JITTER_FACTOR * Math.random()), RETRY_MAX_DELAY);
}

/** 从 APIError.headers 里读头部，兼容 fetch Headers 实例与普通 record。 */
function readHeader(err: unknown, name: string): string | undefined {
  if (!(err instanceof Anthropic.APIError) || !err.headers) return undefined;
  const headers = err.headers as Headers | Record<string, string>;
  const value =
    typeof (headers as { get?: (n: string) => string | null }).get === "function"
      ? (headers as Headers).get(name)
      : (headers as Record<string, string>)[name];
  return typeof value === "string" && value.length ? value : undefined;
}