// llm/cache.ts —— 第 7 课：prompt caching 断点注入（对照 opencode llm/cache-policy.ts）
//
// "auto" 策略（默认开）：往三处打 `cache_control: ephemeral` 断点——
//   system 末块 / 最后一个 tool / 最新一条 user 消息。
// 为什么是这三处（opencode cache-policy.ts 注释直说）：
//   一轮 user 消息会在 agent loop 里爆成十几轮 assistant/tool 往返，
//   每次往返的请求前缀（system + tools + 旧历史）都相同，
//   断点打在这三处 → 循环里每次 API 调用都命中同一个缓存前缀，
//   只有新到的 tool result 增量算钱。5 分钟内复用一次就回本（写 1.25x / 读 0.1x）。
//
// 纯函数：输入原始请求，输出打了断点的请求 + 断点清单（供学习日志）。
// 调用方（llm.ts 的 generate/stream）在 `client.messages.create` 之前应用。

import Anthropic from "@anthropic-ai/sdk";

/** 一处断点：打在哪 + 打在哪个块上（给学习日志看的） */
export interface CacheBreakpoint {
  target: "system" | "tools" | "messages";
  detail: string;
}

/** 应用结果：断点注入后的请求三件套 + 断点清单 */
export interface CacheApplied {
  system: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  breakpoints: CacheBreakpoint[];
}

export const CACHE_CONTROL: Anthropic.CacheControlEphemeral = { type: "ephemeral" };

/**
 * 应用缓存策略。enabled=false 时原样返回（零开销，不构造新数组）。
 * 注意：system 从 string 升成 content block 数组——cache_control 是打在"块"上的，
 * string 形态无处可打（这就是 opencode 坚持 system 用 SystemPart[] 的原因）。
 */
export function applyCachePolicy(
  system: string,
  messages: readonly Anthropic.MessageParam[],
  tools: readonly Anthropic.Tool[],
  enabled: boolean,
): CacheApplied {
  const breakpoints: CacheBreakpoint[] = [];
  if (!enabled) {
    return { system, messages: messages as Anthropic.MessageParam[], tools: tools as Anthropic.Tool[], breakpoints };
  }

  // ── system：string → 单块数组，末块（就是唯一一块）打断点 ──
  let nextSystem: string | Anthropic.TextBlockParam[] = system;
  if (system.length > 0) {
    nextSystem = [{ type: "text", text: system, cache_control: CACHE_CONTROL }];
    breakpoints.push({ target: "system", detail: "system 唯一块（整个 system prompt 入缓存）" });
  }

  // ── tools：最后一个 tool 打断点（Anthropic 约定：缓存断点在最后一个 tool 上）──
  let nextTools = tools as Anthropic.Tool[];
  if (tools.length > 0) {
    const last = tools.length - 1;
    if (!tools[last].cache_control) {
      nextTools = tools.map((t, i) => (i === last ? { ...t, cache_control: CACHE_CONTROL } : t));
    }
    breakpoints.push({ target: "tools", detail: `第 ${last + 1}/${tools.length} 个 tool（${tools[last].name}）` });
  }

  // ── messages：最新一条 user 消息的最后一个 text 块打断点 ──
  let nextMessages = messages as Anthropic.MessageParam[];
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser >= 0) {
    const target = messages[lastUser];
    // content 可能是 string 或块数组；断点必须打在"块"上，string 先升成单块数组
    if (typeof target.content === "string") {
      nextMessages = messages.map((m, i) =>
        i === lastUser
          ? {
              ...m,
              content: [{ type: "text", text: target.content as string, cache_control: CACHE_CONTROL }],
            }
          : m,
      );
    } else {
      const blocks = target.content as Anthropic.ContentBlockParam[];
      if (blocks.length > 0) {
        // 最后一个 text 块；没有 text 块就退而打最后一个块（tool-result-only 消息同理）
        let markAt = -1;
        for (let i = blocks.length - 1; i >= 0; i--) {
          if (blocks[i].type === "text") {
            markAt = i;
            break;
          }
        }
        if (markAt < 0) markAt = blocks.length - 1;
        const existing = blocks[markAt];
        if (!("cache_control" in existing) || !existing.cache_control) {
          nextMessages = messages.map((m, i) => {
            if (i !== lastUser) return m;
            const nextContent = blocks.map((b, j) =>
              j === markAt ? { ...b, cache_control: CACHE_CONTROL } : b,
            );
            return { ...m, content: nextContent };
          });
        }
      }
    }
    breakpoints.push({ target: "messages", detail: `最新 user 消息（#${lastUser + 1}/${messages.length}）最后一个 text 块` });
  }

  return { system: nextSystem, messages: nextMessages, tools: nextTools, breakpoints };
}

/** 学习日志：把断点清单格式化成可读文本（renderer 只负责画框）。 */
export function formatCacheBreakpoints(bps: readonly CacheBreakpoint[]): string {
  if (bps.length === 0) return "（缓存已关闭或无处可打）";
  return bps.map((b) => `- ${b.target.padEnd(8)} ${b.detail}`).join("\n");
}
