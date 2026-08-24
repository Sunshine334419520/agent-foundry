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
import { getAgent } from "../agent/agent.js";
import { toolRegistry } from "../tool/registry.js";
import { maybeCompact } from "../session/compaction.js";
import { bus } from "../bus/event-bus.js";
import { estimateCost, loadConfig } from "../config/config.js";
import { initialStreamState, reduceStream, finalText, hasToolCalls } from "../llm/stream.js";

// 收尾指令 —— 借鉴 opencode max-steps.ts：到步数上限时让模型自己收尾，而不是硬切断。
const MAX_STEPS_PROMPT = `CRITICAL - MAXIMUM STEPS REACHED
The maximum number of steps for this task has been reached. Do NOT call any tools.
Provide a concise final response: what was accomplished, what remains, and what you'd do next.`;

// 命名常量：防病态死循环的背板 & 软步数默认值（原魔法数字 10_000 / 30）
const MAX_BACKSTOP_STEPS = 10_000;
const DEFAULT_MAX_STEPS = 30;

export interface RunResult {
  text: string;
  usage: Usage;
  interrupted: boolean;
  /** stop_reason 为 max_tokens：正文可能被截断，标记出来而不是静默当成完整结果 */
  truncated?: boolean;
}

export interface RunOptions {
  /** 每个 user 回合的软步数上限（默认 30），到上限靠收尾 prefill，不硬切 */
  maxSteps?: number;
  /** 中断信号：可中止当前流式请求 */
  signal?: AbortSignal;
  /** 学习日志：把"发给 AI 的完整请求 / AI 返回内容"打出来（默认开，/verbose 可关） */
  verbose?: boolean;
}

export class AgentLoop {
  constructor(private readonly llm: LLM) {}

  /**
   * 驱动器：追加 user 消息 → 反复单步直到收尾。返回最终文本 + 本轮累计用量。
   * 每一步的细节通过 bus 发布，渲染由订阅者完成。
   */
  async run(session: Session, userInput: string, opts: RunOptions = {}): Promise<RunResult> {
    const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
    const signal = opts.signal;
    const verbose = opts.verbose ?? true; // 学习模式默认全开
    session.addUser(userInput);

    // 第 6 课：溢出检测 → 自动压缩（保留最近 2 轮 + 旧上下文压成锚定摘要）。
    // 压缩会消耗一次 LLM 调用，所以只在实际溢出时触发（maybeCompact 先判 isOverflow）。
    const cfg = loadConfig();
    const compacted = await maybeCompact(this.llm, session, cfg, verbose);
    if (compacted) bus.emit({ type: "compact", reason: "overflow" });

    // 第 3 课：人格不再是焊死的常量——按 session 当前 agent 解析（prompt + 工具白名单）。
    // 第 5 课：工具白名单由 registry.toolsFor(agent) 统一裁剪（原 resolveTools 挪进注册表）。
    const agent = getAgent(session.agent);
    const tools = toolRegistry.toolsFor(agent);

    const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let final = "";
    let interrupted = false;
    let truncated = false;

    try {
      // 背板只是防病态死循环；正常靠停止条件自然退出，到软上限靠收尾 prefill + 硬收尾。
      for (let step = 0; step < MAX_BACKSTOP_STEPS; step++) {
        // off-by-one 修正：maxSteps=30 给 30 次 LLM 调用（step 0..29，第 30 次就是末步）。
        const isLastStep = step >= maxSteps - 1;
        // 请求构建：只吃 Session 的适配产物（存储→协议），尾部拼收尾 prefill（仅当次请求）。
        const requestMessages: Anthropic.MessageParam[] = [
          ...session.toModelMessages(),
          ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS_PROMPT }] : []),
        ];
        bus.emit({ type: "step-start", step: step + 1, model: this.llm.model, isLastStep, messageCount: requestMessages.length, toolCount: tools.length });
        if (verbose) {
          // 学习日志：这次调用到底发了什么（system + 完整 messages + 工具列表）
          bus.emit({
            type: "debug",
            label: `step ${step + 1} · 发给 AI 的完整请求`,
            content: formatRequest(agent.prompt, requestMessages, tools),
          });
        }

        // ── 单步：一条 LLM 流。纯折叠供控制决策，每事件发布给订阅者 ──
        // try/finally：流中途抛错（abort/失败）也照样发 step-end、落记忆、记用量——
        // 渲染端不会因缺 step-end 而悬挂，模型已产出的半成品也不会丢。
        let state = initialStreamState();
        try {
          for await (const ev of this.llm.stream({
            system: agent.prompt,
            messages: requestMessages,
            tools,
            signal,
            verbose, // 第 7 课：caching 断点注入的学习日志
          })) {
            state = reduceStream(state, ev); // 组装（agent 自己的控制状态）
            bus.emit({ type: "stream", event: ev }); // 发布（给所有订阅者：渲染/日志/…）
          }
          if (verbose) {
            // 学习日志：AI 到底回了什么（text + tool_use 块）
            bus.emit({ type: "debug", label: `step ${step + 1} · AI 返回`, content: formatBlocks(state.blocks) });
          }
        } finally {
          this.addUsage(usage, state.usage); // finish 事件带的用量累进本轮（含中断时已产出的部分）
          if (state.blocks.length > 0) session.addAssistant(state.blocks); // 落记忆（中断也留半成品）
          bus.emit({ type: "step-end", stopReason: state.stopReason, usage: state.usage });
        }

        // 中断检查：abort 时 SDK 的流可能"干净地"结束而不抛异常（拿不到 message_stop），
        // 这里兜住——否则会把一个被打断的空回复当成正常收尾。
        if (signal?.aborted) {
          interrupted = true;
          final = "（已中断）";
          break;
        }

        // ── 停止条件：双传感器（prompt.ts:1104-1130）──
        if (state.stopReason === "tool_use" || hasToolCalls(state)) {
          // 还有活 → 挨个执行工具（我们同步执行，结果回喂），进入下一轮
          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          let finished = false;
          let finishSummary: string | undefined;
          for (const tu of state.blocks.filter((b): b is Anthropic.ToolUseBlockParam => b.type === "tool_use")) {
            const input = tu.input as Record<string, unknown>;
            if (tu.name === "finish") {
              // finish = 收尾信号（SYSTEM_PROMPT 明说"任务完成就调 finish"）：
              // 不执行、不回喂 result；summary 作最终答复，立刻终止。
              // 仍补一条 result，让存储里不留"未完成工具"（否则下次会话会被派生为 interrupted）。
              finished = true;
              finishSummary = typeof input?.summary === "string" ? input.summary : undefined;
              toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: finishSummary ?? "Task marked as complete." });
              continue;
            }
            // 第 5 课：执行统一走 registry（校验→execute→截断→"请重写"兜底），async 支持 webfetch
            const result = await toolRegistry.execute(tu.name, input);
            bus.emit({ type: "tool-run", name: tu.name, input, output: result });
            toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
          }
          session.addToolResults(toolResults);

          if (finished) {
            // finish 已表态 → 收尾：summary 优先，正文兜底
            final = finishSummary ?? finalText(state);
            break;
          }
          if (toolResults.length === 0) {
            // stop_reason 声称 tool_use 却没有实际工具块（半截/中断）→ 按结束处理，别空转烧 token
            final = finalText(state);
            break;
          }
          if (isLastStep) {
            // 软上限已到、prefill 没压住（模型仍要工具）→ 执行完这批就硬收尾，不再多烧一轮
            final = finalText(state);
            break;
          }
          continue;
        }

        // 非工具且无挂起工具 → 收尾；max_tokens 时标记截断，别静默当完整结果
        final = finalText(state);
        truncated = state.stopReason === "max_tokens";
        break;
      }
    } catch (err) {
      // ── halt（processor.ts:599-625）：重试耗尽 / 不可重试 → 落 error，不静默吞 ──
      // 错误文本通过返回值交给订阅者展示，这里不直接打印。
      if (err instanceof Anthropic.APIUserAbortError || signal?.aborted) {
        interrupted = true;
        final = "（已中断）"; // 用户主动打断 = 流程，不是错误
      } else {
        const message = err instanceof Error ? err.message : String(err);
        final = `[error] ${message}`;
      }
    } finally {
      // 无论正常/中断/出错都发 turn-end，让渲染端能收尾（原实现提前 return 绕过了它）
      bus.emit({ type: "turn-end", usage, costLine: costLine(this.llm.model, usage) });
    }
    // cleanup：同步模型无"在飞工具"要标记，退化为无操作

    return { text: final, usage, interrupted, ...(truncated ? { truncated: true } : {}) };
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

// ── 学习日志：把"发给 AI 的东西 / AI 返回的东西"格式化成可读文本 ──

/** 完整请求：system + 逐条消息（text/tool_use/tool_result 块都转成文本） */
function formatRequest(
  system: string,
  messages: readonly Anthropic.MessageParam[],
  tools: readonly Anthropic.Tool[],
): string {
  const lines = [`【system】\n${system}`];
  for (const m of messages) {
    const role = m.role;
    const content =
      typeof m.content === "string"
        ? m.content
        : m.content
            .map((c) => {
              if (c.type === "text") return c.text;
              if (c.type === "tool_use") return `[tool_use] ${c.name}(${JSON.stringify(c.input)})`;
              if (c.type === "tool_result")
                return `[tool_result] ${typeof c.content === "string" ? c.content : JSON.stringify(c.content)}`;
              return `[${c.type}]`;
            })
            .join("\n");
    lines.push(`\n【${role}】\n${content}`);
  }
  lines.push(`\n【tools】\n${tools.map((t) => `- ${t.name}: ${t.description}`).join("\n")}`);
  return lines.join("\n");
}

/** AI 返回的块：text / tool_use / thinking 都转成可读文本 */
function formatBlocks(blocks: readonly Anthropic.ContentBlockParam[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.type === "text") lines.push(b.text);
    else if (b.type === "tool_use") lines.push(`[tool_use] ${b.name}(${JSON.stringify(b.input)})`);
    else if (b.type === "thinking") lines.push(`[thinking] ${b.thinking}`);
  }
  return lines.join("\n") || "（空）";
}