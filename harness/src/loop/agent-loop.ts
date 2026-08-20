// loop/agent-loop.ts —— 编排层：AgentLoop 驱动器（纯生产者）
//
// 对应 opencode prompt.ts(runLoop) + processor.ts(process)。
// 本文件【不渲染、不打印】——所有对外信息都经 bus.publish 发给订阅者（renderer/日志/未来 server）。
// 它只做四件事：
//   1. 驱动器：追加 user → 反复单步直到收尾
//   2. 单步内消费 LLM 流：reduceStream 纯折叠（供自己的控制决策）
//   3. 域逻辑：落记忆（session）、执行工具（tools）、错误分层（halt）
//   4. 发布：step-start / stream / step-end / tool-run / turn-end 到事件总线
// 对照 opencode：processor 逐事件 updatePart 落库 + events.publish → server SSE → UI 订阅。

import Anthropic from "@anthropic-ai/sdk";
import { Session } from "../session/session.js";
import { LLM, type Usage } from "../llm/llm.js";
import { TOOLS, executeTool } from "../tool/tool.js";
import { bus } from "../bus/event-bus.js";
import { estimateCost } from "../config/config.js";
import { initialStreamState, reduceStream, finalText, hasToolCalls } from "../llm/stream.js";

const SYSTEM_PROMPT = `You are an AI coding agent. You have access to tools for reading/writing files and running commands.
Work step by step. Read files before editing them. When the task is done, call the finish tool.
Be precise and careful with file operations.`;

// 收尾指令 —— 借鉴 opencode max-steps.ts：到步数上限时让模型自己收尾，而不是硬切断。
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
  /** 中断信号：可中止当前流式请求 */
  signal?: AbortSignal;
}

export class AgentLoop {
  constructor(private readonly llm: LLM) {}

  /**
   * 驱动器：追加 user 消息 → 反复单步直到收尾。返回最终文本 + 本轮累计用量。
   * 每一步的细节通过 bus 发布，渲染由订阅者完成。
   */
  async run(session: Session, userInput: string, opts: RunOptions = {}): Promise<RunResult> {
    const maxSteps = opts.maxSteps ?? 30;
    const signal = opts.signal;
    session.addUser(userInput);

    const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let final = "";

    try {
      // 10_000 只是防病态死循环的背板；正常靠停止条件自然退出，超预算靠收尾 prefill。
      for (let step = 0; step < 10_000; step++) {
        const isLastStep = step >= maxSteps;
        // 请求构建：只吃 Session 的适配产物（存储→协议），尾部拼收尾 prefill（仅当次请求）。
        const requestMessages: Anthropic.MessageParam[] = [
          ...session.toModelMessages(),
          ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS_PROMPT }] : []),
        ];
        bus.emit({ type: "step-start", step: step + 1, model: this.llm.model, isLastStep, messageCount: requestMessages.length, toolCount: TOOLS.length });

        // ── 单步：一条 LLM 流。纯折叠供控制决策，每事件发布给订阅者 ──
        let state = initialStreamState();
        for await (const ev of this.llm.stream({
          system: SYSTEM_PROMPT,
          messages: requestMessages,
          tools: TOOLS,
          signal,
        })) {
          state = reduceStream(state, ev); // 组装（agent 自己的控制状态）
          bus.emit({ type: "stream", event: ev }); // 发布（给所有订阅者：渲染/日志/…）
        }

        this.addUsage(usage, state.usage); // finish 事件带的用量累进本轮
        session.addAssistant(state.blocks); // 落记忆：存储形状 → part
        bus.emit({ type: "step-end", stopReason: state.stopReason, usage: state.usage });

        // ── 停止条件：双传感器（prompt.ts:1104-1130）──
        if (state.stopReason === "tool_use" || hasToolCalls(state)) {
          // 还有活 → 挨个执行工具（我们同步执行，结果回喂），进入下一轮
          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const tu of state.blocks.filter((b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use")) {
            const input = tu.input as Record<string, unknown>;
            const result = executeTool(tu.name, input);
            bus.emit({ type: "tool-run", name: tu.name, input, output: result });
            toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
          }
          session.addToolResults(toolResults);
          continue;
        }

        // finish ≠ tool-calls 且无挂起工具 → 收尾
        final = finalText(state);
        break;
      }
    } catch (err) {
      // ── halt（processor.ts:599-625）：重试耗尽 / 不可重试 → 落 error，不静默吞 ──
      // 错误文本通过返回值交给订阅者展示，这里不直接打印。
      if (err instanceof Anthropic.APIUserAbortError || signal?.aborted) {
        return { text: "（已中断）", usage, interrupted: true }; // 用户主动打断=流程，不是错误
      }
      const message = err instanceof Error ? err.message : String(err);
      return { text: `[error] ${message}`, usage, interrupted: false };
    }
    // cleanup：同步模型无"在飞工具"要标记，退化为无操作

    bus.emit({ type: "turn-end", usage, costLine: costLine(this.llm.model, usage) });
    return { text: final, usage, interrupted: false };
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
  return cost === null ? "费用 —（未配置价格）" : `费用 ≈ ¥${cost.toFixed(4)}`;
}