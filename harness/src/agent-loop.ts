// agent-loop.ts —— 编排层：AgentLoop 驱动器
//
// 对应 opencode prompt.ts(runLoop) + processor.ts(process)。只做编排，不含 SDK 细节：
//   - 驱动器 run()：session.addUser → 循环单步直到收尾（每步从 0 重算，软限制 maxSteps）
//   - 停止条件：stop_reason + 挂起工具 双传感器（prompt.ts:1100-1130）
//   - 错误处理：retry 在 llm.ts 内部；这里做 halt（APIUserAbort=中断不算错）+ 累计用量
//   - 逐步详情打印：这是学习工具，每一步的请求/响应/stop_reason/用量/工具全曝光
//
// 依赖方向：AgentLoop 操作 Session（数据层），调用 LLM/Tools（能力层）。

import Anthropic from "@anthropic-ai/sdk";
import { Session } from "./session.js";
import { LLM, type Usage, type LLMResponse } from "./llm.js";
import { TOOLS, executeTool } from "./tools.js";
import { estimateCost } from "./config.js";

const SYSTEM_PROMPT = `You are an AI coding agent. You have access to tools for reading/writing files and running commands.
Work step by step. Read files before editing them. When the task is done, call the finish tool.
Be precise and careful with file operations.`;

// 收尾指令 —— 借鉴 opencode max-steps.ts：到步数上限时让模型自己收尾，而不是硬切断。
// 以 role:"assistant" 尾条 prefill 注入，模型顺着这段"它自己已说的话"继续。
const MAX_STEPS_PROMPT = `CRITICAL - MAXIMUM STEPS REACHED
The maximum number of steps for this task has been reached. Do NOT call any tools.
Provide a concise final response: what was accomplished, what remains, and what you'd do next.`;

export interface RunResult {
  text: string;
  usage: Usage;
  interrupted: boolean;
}

export interface RunOptions {
  /** 每个 user 回合的软步数上限（默认 30），到上限靠收尾 prefill，不硬切 */
  maxSteps?: number;
  /** 中断信号：可中止当前 LLM 调用 */
  signal?: AbortSignal;
}

const isToolUse = (b: Anthropic.ContentBlock): b is Anthropic.ToolUseBlock => b.type === "tool_use";
const isText = (b: Anthropic.ContentBlock): b is Anthropic.TextBlock => b.type === "text";
const fmt = (n: number) => n.toLocaleString("en-US");
const trim = (s: string, max: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max) + " …" : one;
};

export class AgentLoop {
  constructor(private readonly llm: LLM) {}

  /**
   * 驱动器：追加 user 消息 → 反复单步直到收尾。返回最终文本 + 本轮累计用量。
   * step 每轮从 0 重算：对应 opencode 每个 user prompt 各自跑一次 runLoop（prompt.ts:1085）。
   */
  async run(session: Session, userInput: string, opts: RunOptions = {}): Promise<RunResult> {
    const maxSteps = opts.maxSteps ?? 30;
    const signal = opts.signal;
    session.addUser(userInput);

    const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let finalText = "";

    try {
      // 10_000 只是防病态死循环的背板；正常靠停止条件自然退出，超预算靠收尾 prefill。
      for (let step = 0; step < 10_000; step++) {
        console.log(`\n▌ Step ${step + 1} · model=${this.llm.model}`);

        const isLastStep = step >= maxSteps;
        // 请求构建：尾部拼收尾 prefill（prompt.ts:1278-1282），仅当次请求、不写进 session。
        const requestMessages: Anthropic.MessageParam[] = [
          ...session.getMessages(),
          ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS_PROMPT }] : []),
        ];
        console.log(`  ▲ 请求 messages=${requestMessages.length} · tools=${TOOLS.length}${isLastStep ? " · [末步 prefill]" : ""}`);

        // ── 单次 LLM 调用（llm.ts 内部完成重试退避）──
        const resp = await this.llm.generate({
          system: SYSTEM_PROMPT,
          messages: requestMessages,
          tools: TOOLS,
          signal,
        });

        this.addUsage(usage, resp.usage);
        session.addAssistant(resp.content);
        this.printResponse(resp);

        // ── 停止条件：双传感器（prompt.ts:1104-1130）──
        const hasTools = resp.content.some(isToolUse);
        if (resp.stopReason === "tool_use" || hasTools) {
          // 还有活 → 挨个执行工具，结果回喂，进入下一轮
          const toolUses = resp.content.filter(isToolUse);
          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const tu of toolUses) {
            const input = tu.input as Record<string, unknown>;
            console.log(`  → ${tu.name}(${JSON.stringify(input)})`);
            const result = executeTool(tu.name, input);
            console.log(`    ← ${result.slice(0, 120)}${result.length > 120 ? "…" : ""}`);
            toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
          }
          session.addToolResults(toolResults);
          continue;
        }

        // finish ≠ tool-calls 且无挂起工具 → 收尾
        finalText = resp.content.filter(isText).map((b) => b.text).join("\n");
        break;
      }
    } catch (err) {
      // ── halt（processor.ts:599-625）：重试耗尽 / 不可重试 → 落 error，不静默吞 ──
      if (err instanceof Anthropic.APIUserAbortError || signal?.aborted) {
        console.log("\n（已中断本轮）");
        return { text: "（已中断）", usage, interrupted: true }; // 用户主动打断=流程，不是错误
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[halt] ${message}`);
      return { text: `[error] ${message}`, usage, interrupted: false };
    }
    // cleanup：同步模型无"在飞工具"要标记，退化为无操作

    console.log(
      `\n━━ 本轮: 输入 ${fmt(usage.input)} · 输出 ${fmt(usage.output)} · 缓存读 ${fmt(usage.cacheRead)} · 写 ${fmt(usage.cacheWrite)}` +
        costLine(this.llm.model, usage),
    );
    return { text: finalText, usage, interrupted: false };
  }

  /** 打印这一轮的请求响应细节（学习工具的核心）。 */
  private printResponse(resp: LLMResponse): void {
    console.log(
      `  ▼ stop_reason=${resp.stopReason} · 输入 ${fmt(resp.usage.input)} · 输出 ${fmt(resp.usage.output)}` +
        ` · 缓存 ${fmt(resp.usage.cacheRead)}/${fmt(resp.usage.cacheWrite)}`,
    );
    for (const b of resp.content) {
      if (b.type === "text" && b.text.trim()) {
        console.log(`  ─ 文本: ${trim(b.text, 300)}`);
      } else if (b.type === "thinking") {
        const thought = (b as { thinking?: string }).thinking;
        if (thought?.trim()) console.log(`  ─ 推理: ${trim(thought, 200)}`);
      }
    }
  }

  private addUsage(total: Usage, step: Usage): void {
    total.input += step.input;
    total.output += step.output;
    total.cacheRead += step.cacheRead;
    total.cacheWrite += step.cacheWrite;
  }
}

function costLine(model: string, usage: Usage): string {
  const cost = estimateCost(model, usage);
  return cost === null ? " · 费用 —（未配置价格）" : ` · 费用 ≈ ¥${cost.toFixed(4)}`;
}