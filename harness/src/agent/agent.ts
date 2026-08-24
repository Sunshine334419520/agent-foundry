// agent/agent.ts —— 数据层：Agent = 人设 + 工具权限（第 3 课落地）
//
// 学 opencode agent/agent.ts 的本课要点，落到我们 harness：
//   1. Agent 就是一份配置数据：prompt（人格）+ tools（能力白名单）+ 元信息——没有新代码路径。
//      "换人设 + 换权限 = 换个 agent"，正是 opencode 的 explore/plan/title 都走同一 Info 结构的落点。
//   2. 权限我们只做"工具白名单"这一档（#8 权限矩阵的 allow/ask/deny 之后再上）：
//        tools 未定义       = 全开（对应 opencode 的 `*`: "allow" 默认）
//        tools 给定数组      = 只给这些工具（对应 explore 的 `*`: "deny" + 白名单哲学）
//   3. 强制兜底：finish 永远留在工具集里（对应 opencode 的 Truncate.GLOB 兜底，agent.ts:296-310），
//      否则 agent 将永远无法用 finish 收尾。
//
// 刻意不做：#8 权限矩阵、用户配置合并（agent.ts:267-294）、generate（:368-436）、
// subagent mode 语义——留给后续课。type 也刻意保持"够用即可"：温度/模型等调参字段
// 等用到再长（§八 的"缺省即默认"同样适用：字段不写 = 用模型默认）。

export interface Agent {
  name: string;
  description: string;
  /** 信息性字段（harness 暂只有 primary，无子代理；subagent/all 语义留 #4） */
  mode: "primary" | "subagent" | "all";
  /** 对用户隐藏（第 6 课：compaction 这类"内部杂活"agent 不展示、不可选，对应 opencode hidden） */
  hidden?: boolean;
  /** ⭐ 人设（系统提示词）——opencode 的 `prompt` 字段 */
  prompt: string;
  /** ⭐ 工具白名单：undefined = 全开；给定数组 = 只给这些工具。finish 由 resolveTools 强制兜底 */
  tools?: string[];
  temperature?: number;
}

// build 人格 —— 原 agent-loop.ts 的 SYSTEM_PROMPT 常量迁移至此（行为零变化）
const PROMPT_BUILD = `You are an AI coding agent. You have access to tools for reading/writing files and running commands.
Work step by step. Read files before editing them. When the task is done, call the finish tool.
Be precise and careful with file operations.`;

// plan 人格 —— 按 §九 prompt 原理起草：第一行定角色定边界 → 工具映射 → 负向约束 → 输出契约
const PROMPT_PLAN = `You are a planning agent. You analyze a task and produce a step-by-step plan, but you never modify files.
Use read_file and list_files to inspect the codebase, and run_command to gather information.
You MUST NOT call write_file. Do not modify any files.
When your plan is ready, call the finish tool and put the plan in the summary field.`;

// compaction 人格（第 6 课）—— 移植 opencode compaction.txt，断链提示 + 输出契约。
// 它是"内部杂活"agent：把旧对话压成锚定摘要，正常对话永不直接选它（hidden）。
const PROMPT_COMPACTION = `You are an anchored context summarization assistant for coding sessions.
Summarize only the conversation history you are given. The newest turns may be kept verbatim outside your summary, so focus on the older context that still matters for continuing the work.
If the prompt includes a <previous-summary> block, treat it as the current anchored summary. Update it with the new history by preserving still-true details, removing stale details, and merging in new facts.
Always follow the exact output structure requested by the user prompt. Keep every section, preserve exact file paths and identifiers when known, and prefer terse bullets over paragraphs.
Do not answer the conversation itself. Do not mention that you are summarizing, compacting, or merging context. Respond in the same language as the conversation.`;

/** 内置 agent 表（对应 opencode agent.ts:140-265 的 agents 记录，最小版） */
export const AGENTS: Agent[] = [
  {
    name: "build",
    description: "默认 agent：全能主力，读写文件、跑命令",
    mode: "primary",
    prompt: PROMPT_BUILD,
  },
  {
    name: "plan",
    description: "规划 agent：只读分析出计划，禁止写文件",
    mode: "primary",
    prompt: PROMPT_PLAN,
    // 工具白名单 = 表达"不许 edit"：不给 write_file。run_command 保留（对齐 opencode：
    // plan 只 deny edit 工具、bash 仍 allow，agent.ts:171-175）；真·plan 模式的
    // plan_enter/plan_exit 流程属 #8。
    tools: ["read_file", "list_files", "run_command", "finish"],
  },
  {
    name: "compaction",
    description: "隐藏 agent：把旧对话压成锚定摘要",
    mode: "primary",
    hidden: true,
    prompt: PROMPT_COMPACTION,
    // 压缩不调任何工具：compact 直接给 llm.generate 传 tools: []。白名单留空 = 空集（只剩 finish 兜底）
    tools: [],
  },
];

/** 默认 agent（opencode 的 default_agent 配置，harness 先硬编码） */
export const DEFAULT_AGENT = "build";

const byName = new Map(AGENTS.map((a) => [a.name, a]));

/** 按名字取 agent；未知名字抛错（对应 opencode agents.get()） */
export function getAgent(name: string): Agent {
  const agent = byName.get(name);
  if (!agent) {
    const available = AGENTS.map((a) => a.name).join(", ");
    throw new Error(`agent "${name}" not found. Available: ${available}`);
  }
  return agent;
}

/** 列出全部 agent（opencode agents.list() 的最小版；排序留给 UI） */
export function listAgents(): Agent[] {
  return AGENTS;
}
