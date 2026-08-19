// session.ts —— 数据层：Session = 会话记忆的容器
//
// 对应 opencode session/session.ts（我们做内存版）。只干一件事：持有/追加消息。
// 重要心智模型：Session 是"被动的记录"，AgentLoop 是"作用在它上面的流程"。
//   一个 Session 可以在不同时刻被多个 AgentLoop 轮次读写（今天问、明天续聊）。
// 刻意不做（留给后面）：数据库持久化(#13)、schema 版本化(#2)。

import Anthropic from "@anthropic-ai/sdk";

export class Session {
  /** ⭐ 记忆 = 这一个数组。类型直接复用 SDK 消息格式（学习阶段不追求解耦）。 */
  private messages: Anthropic.MessageParam[] = [];

  /** 追加一条 user 消息（自然语言输入） */
  addUser(input: string): void {
    this.messages.push({ role: "user", content: input });
  }

  /** 追加 assistant 完整回复（保留 text / tool_use / thinking 块） */
  addAssistant(content: Anthropic.ContentBlock[]): void {
    this.messages.push({ role: "assistant", content });
  }

  /** 追加工具结果（作为 user 消息回喂给模型） */
  addToolResults(results: Anthropic.ToolResultBlockParam[]): void {
    this.messages.push({ role: "user", content: results });
  }

  /** 供 LLM 构建请求的只读视图 */
  getMessages(): readonly Anthropic.MessageParam[] {
    return this.messages;
  }

  /** 当前记忆条数（user + assistant + tool_result 都算） */
  get messageCount(): number {
    return this.messages.length;
  }

  /** 清空记忆（话题重开） */
  reset(): void {
    this.messages = [];
  }
}