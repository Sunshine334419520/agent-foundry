// cli/render.ts —— 副作用消费者：订阅总线，把循环生命周期画到终端
//
// 学 opencode：UI 是独立于 agent loop 的订阅者（server HTTP SSE → TUI），
// loop 只 publish、不渲染。这里就是这个"UI 端"的最小版。
// 约定：正文走 stdout（结构化输出），推理/工具参数走 stderr（观察性信息）。

import type { BusEvent } from "../bus/event-bus.js";
import type { StreamEvent } from "../llm/llm.js";

const fmt = (n: number) => n.toLocaleString("en-US");
const trim = (s: string, max: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max) + "…" : one;
};

export class ReplRenderer {
  private reasoningHasText = false;
  private streamWrote = false; // 本次流是否写过正文（决定 step-end 前是否补换行）

  /** 订阅者入口：总线每来一个事件就画一笔。 */
  on(event: BusEvent): void {
    switch (event.type) {
      case "step-start":
        console.log(`\n▌ Step ${event.step} · model=${event.model}`);
        console.log(
          `  ▲ 请求 messages=${event.messageCount} · tools=${event.toolCount}` +
            (event.isLastStep ? " · [末步 prefill]" : ""),
        );
        break;

      case "stream":
        this.renderStream(event.event);
        break;

      case "step-end":
        if (this.streamWrote) console.log(""); // 给流式正文收尾换行
        this.streamWrote = false;
        console.log(
          `  ▼ stop_reason=${event.stopReason} · 输入 ${fmt(event.usage.input)} · 输出 ${fmt(event.usage.output)}` +
            ` · 缓存 ${fmt(event.usage.cacheRead)}/${fmt(event.usage.cacheWrite)}`,
        );
        break;

      case "tool-run":
        console.log(`  → ${event.name}(${JSON.stringify(event.input)})`);
        console.log(`    ← ${trim(event.output, 120)}`);
        break;

      case "turn-end":
        console.log(
          `\n━━ 本轮: 输入 ${fmt(event.usage.input)} · 输出 ${fmt(event.usage.output)}` +
            ` · 缓存读 ${fmt(event.usage.cacheRead)} · 写 ${fmt(event.usage.cacheWrite)} · ${event.costLine}`,
        );
        break;
    }
  }

  private renderStream(ev: StreamEvent): void {
    switch (ev.type) {
      case "text-delta":
        this.streamWrote = true;
        process.stdout.write(ev.text); // 实时吐字
        break;

      case "reasoning-start":
        this.reasoningHasText = false;
        process.stderr.write("\n⟦思考 ");
        break;
      case "reasoning-delta":
        this.reasoningHasText = true;
        process.stderr.write(ev.text);
        break;
      case "reasoning-end":
        if (this.reasoningHasText) process.stderr.write(" ⟧\n");
        break;

      case "tool-input-start":
        process.stderr.write(`\n⟦工具 ${ev.name} 参数⟧ `);
        break;
      case "tool-input-delta":
        process.stderr.write(ev.text);
        break;
      case "tool-input-end":
        process.stderr.write(" ⟧\n");
        break;

      default:
        // text-start/text-end/tool-call/finish 不需要即时绘制（闭合处由汇总事件打）
        break;
    }
  }
}