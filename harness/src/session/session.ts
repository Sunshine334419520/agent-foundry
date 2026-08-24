// session/session.ts —— 数据层：Session = 会话记忆的容器（第 2 课升级版）
//
// 学 opencode session/ 的本课要点，落到我们 harness：
//   1. 消息模型自带结构：id / parentID / version / parts，不再裸存 SDK 数组
//      —— 为将来落盘（#13）留好了"行"的形状，换 DB 只需换存储实现。
//   2. toModelMessages() = 存储形状 → 协议形状 的唯一适配点。
//      上游（agent-loop/cli）只吃这个适配结果，永远不知道底层是数组还是库。
//   3. 推理块（reasoning）故意不回传给模型：推理是"内部草稿"，不需要进上下文，
//      也顺势避开 thinking 块 signature 的耦合问题（照应 02 文档 3.2/7.2）。
//   4. 工具结果挂在 assistant 消息的 tool part 上（而不是造一条假 user 消息），
//      适配时再展开成 protocol 要求的 user(tool_result)——存储规范、协议推演。
//   5. 未完成的工具（无 result）→ 派生一条 "…was interrupted" 错误结果，
//      保证 Anthropic 协议"每个 tool_use 都有 tool_result"不变量（02 文档 Q4）。
//
// 刻意不做：Schema 校验/版本迁移、DB 持久化、状态机（留给 #13 / 后续 D 步）。

import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_AGENT } from "../agent/agent.js";

// ── 存储形状：我们自己的消息模型（不依赖 SDK 类型，可独立落盘）──

export interface ToolResultRef {
  output: string;
  isError: boolean;
}

export type StoredPart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool";
      callID: string;
      tool: string;
      input: unknown;
      result?: ToolResultRef; // 工具跑完后由 addToolResults 挂上
    };

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  parentID?: string; // assistant 回答的是哪条 user（第 1 课停止条件④的基础）
  version: 1; // 版本号：将来做迁移的门
  timeCreated: number;
  parts: StoredPart[];
}

// 时间有序、进程内唯一的可排序 ID（学 opencode 的 msg-/prt-，简化版）
let seq = 0;
function ascending(prefix: string): string {
  return `${prefix}-${Date.now()}-${(seq++).toString(36)}`;
}

function findLast<T>(arr: T[], pred: (t: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return arr[i];
  return undefined;
}

export class Session {
  private messages: StoredMessage[] = [];

  // 第 3 课：当前 agent。opencode 里 agent 是"挂在每个 user 消息上"的粒度（lastUser.agent），
  // 会话级一条够我们用（#4 子代理时再考虑消息级）。
  private agentName: string = DEFAULT_AGENT;

  // 第 6 课：已折叠段的锚定摘要 + 折叠偏移（前 foldedUntil 条消息被摘要覆盖）。
  // 折叠是可追溯的：旧消息还在 messages 里，只是 toModelMessages 组装时跳过。
  private summary: { text: string; foldedUntil: number } | undefined;

  /** 追加一条 user 消息，返回它的 id */
  addUser(input: string): string {
    const msg: StoredMessage = {
      id: ascending("msg"),
      role: "user",
      version: 1,
      timeCreated: Date.now(),
      parts: [{ type: "text", text: input }],
    };
    this.messages.push(msg);
    return msg.id;
  }

  /** 追加一条 assistant 消息：把内容块映射成我们的 part（text / tool / reasoning）。 */
  addAssistant(content: Anthropic.ContentBlockParam[]): string {
    const parentUser = findLast(this.messages, (m) => m.role === "user");
    const parts: StoredPart[] = content.flatMap((b): StoredPart[] => {
      if (b.type === "text") return [{ type: "text", text: b.text }];
      if (b.type === "tool_use") return [{ type: "tool", callID: b.id, tool: b.name, input: b.input }];
      if (b.type === "thinking") return [{ type: "reasoning", text: b.thinking }];
      return []; // 其它块（图片等）暂不存储
    });
    const msg: StoredMessage = {
      id: ascending("msg"),
      role: "assistant",
      parentID: parentUser?.id,
      version: 1,
      timeCreated: Date.now(),
      parts,
    };
    this.messages.push(msg);
    return msg.id;
  }

  /** 把工具结果按 callID 挂到最近一条 assistant 消息的 tool part 上。 */
  addToolResults(results: Anthropic.ToolResultBlockParam[]): void {
    const lastAssistant = findLast(this.messages, (m) => m.role === "assistant");
    if (!lastAssistant) return;
    for (const r of results) {
      const part = lastAssistant.parts.find((p) => p.type === "tool" && p.callID === r.tool_use_id);
      if (part?.type !== "tool") continue;
      part.result = {
        output: typeof r.content === "string" ? r.content : JSON.stringify(r.content),
        isError: r.is_error === true,
      };
    }
  }

  /** 存储形状 → Anthropic 协议形状 的唯一适配点。 */
  toModelMessages(): Anthropic.MessageParam[] {
    const out: Anthropic.MessageParam[] = [];
    // 第 6 课：若存在折叠摘要，先以 assistant 文本块开头（压缩段的"化身"），
    // 再从折叠偏移处继续——旧消息被跳过但留在存储里可审计。
    const start = this.summary?.foldedUntil ?? 0;
    if (this.summary && start > 0) {
      out.push({ role: "assistant", content: [{ type: "text", text: this.summary.text }] });
    }
    for (let i = start; i < this.messages.length; i++) {
      const msg = this.messages[i];
      if (msg.role === "user") {
        const texts = msg.parts.filter((p): p is Extract<StoredPart, { type: "text" }> => p.type === "text");
        if (texts.length === 0) continue;
        // abort/中断可能留下"孤儿 user"（user 已入库但 assistant 没应答）→ 与上一条 user 合并，
        // 避免协议层出现 user+user。只有"纯文本"的 user 可合并；带 tool_result 的 user 是协议产物，不能动。
        const last = out[out.length - 1];
        const lastIsTextUser =
          last?.role === "user" &&
          Array.isArray(last.content) &&
          last.content.length > 0 &&
          last.content.every((c) => c.type === "text");
        const textBlocks = texts.map((t): Anthropic.TextBlockParam => ({ type: "text", text: t.text }));
        if (lastIsTextUser && last && Array.isArray(last.content)) {
          // 运行时已由 lastIsTextUser 确认全为 text 块；这里用 type-guard 收窄合并
          const prevTexts = last.content.filter((c): c is Anthropic.TextBlockParam => c.type === "text");
          const merged: Anthropic.TextBlockParam[] = [...prevTexts, ...textBlocks];
          out[out.length - 1] = { role: "user", content: merged };
        } else {
          out.push({ role: "user", content: textBlocks });
        }
        continue;
      }

      // assistant：文本→text 块；工具→tool_use 块 + 派生一条 user(tool_result)
      const blocks: Anthropic.ContentBlockParam[] = [];
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const part of msg.parts) {
        if (part.type === "text") blocks.push({ type: "text", text: part.text });
        if (part.type === "tool") {
          blocks.push({ type: "tool_use", id: part.callID, name: part.tool, input: part.input });
          const hadResult = part.result !== undefined;
          results.push({
            type: "tool_result",
            tool_use_id: part.callID,
            // 未完成的工具（被打断）→ 按协议要求补齐一条"中断"结果（02 文档 Q4 的落地）
            content: hadResult ? part.result!.output : "[Tool execution was interrupted]",
            ...(hadResult && part.result!.isError ? { is_error: true } : {}),
          });
        }
        // reasoning 刻意不回传：推理不进上下文
      }
      if (blocks.length === 0) continue;
      out.push({ role: "assistant", content: blocks });
      if (results.length > 0) out.push({ role: "user", content: results });
    }
    return out;
  }

  /** 当前记忆条数 */
  get messageCount(): number {
    return this.messages.length;
  }

  /** 当前 agent 名（第 3 课：agent-loop 按它解析人格 + 工具白名单） */
  get agent(): string {
    return this.agentName;
  }

  /** 切换当前 agent（名字合法性由调用方用 getAgent 校验） */
  setAgent(name: string): void {
    this.agentName = name;
  }

  // ── 第 6 课：压缩折叠 ──
  /** 已折叠段的锚定摘要（无则 undefined；anchored 增量更新靠它） */
  get summaryText(): string | undefined {
    return this.summary?.text;
  }

  /** 全部存储消息（只读视图，压缩编排用它做边界决策） */
  get allMessages(): StoredMessage[] {
    return this.messages;
  }

  /** 记录压缩结果：摘要文本 + 折叠偏移（前 foldedUntil 条被摘要覆盖） */
  setSummary(text: string, foldedUntil: number): void {
    this.summary = { text, foldedUntil };
  }

  /** 清空记忆（话题重开） */
  reset(): void {
    this.messages = [];
    this.summary = undefined;
  }
}