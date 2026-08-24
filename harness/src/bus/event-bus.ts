// bus/event-bus.ts —— 事件总线（in-process 发布/订阅）
//
// 学 opencode GlobalBus + EventV2.listen：producer 只 publish、consumer 独立 subscribe，
// 双方互不认识，按需挂接/卸下。这里用极简 Set 实现（比原生 EventEmitter 的类型更干净）：
//   bus.on(cb)      → 返回取消订阅函数（对应 opencode 的 unsubscribe）
//   bus.emit(event) → 逐个通知，单个消费者抛错被隔离，不拖垮生产者
// 对应 opencode 里"渲染端坏了不能拖死 agent loop"的工程要求。

import type { StreamEvent, Usage } from "../llm/llm.js";

/** 总线上流通的事件 = 语义流事件 + 循环生命周期事件。 */
export type BusEvent =
  | { type: "step-start"; step: number; model: string; isLastStep: boolean; messageCount: number; toolCount: number }
  | { type: "stream"; event: StreamEvent } // 语义流事件（text/reasoning/tool-input/tool-call/finish…）
  | { type: "step-end"; stopReason: string | undefined; usage: Usage }
  | { type: "tool-run"; name: string; input: unknown; output: string }
  | { type: "compact"; reason: "overflow" } // 第 6 课：溢出触发的自动压缩
  | { type: "debug"; label: string; content: string } // 学习日志：完整请求/AI 返回/摘要过程（verbose 时发）
  | { type: "turn-end"; usage: Usage; costLine: string };

type Listener = (event: BusEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();

  /** 订阅。返回取消订阅函数（对应 opencode listen→unsubscribe）。 */
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 发布。消费者异常只记录，不影响生产者继续跑。 */
  emit(event: BusEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        console.error(`[bus] 消费者抛错，已隔离: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

/** 进程级单例：producer（agent-loop）与 consumer（renderer/日志/未来 server）共用。 */
export const bus = new EventBus();