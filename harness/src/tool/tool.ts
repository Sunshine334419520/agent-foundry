// tool/tool.ts —— 工具系统（第 5 课升级版：从"数组 + switch"到"数据 + 注册"）
//
// 学 opencode tool/tool.ts + registry.ts 的本课要点，落到我们 harness：
//   1. ToolDef = 一份"工具身份证"：id/description/inputSchema（模型看到）+ execute（我们干活）。
//   2. 统一返回契约：execute 产出 { output, metadata? }——output 只给模型，metadata 给 UI/审计。
//      （我们 execute 直接返回 string 也行，为省事统一走 registry 包装成规范形状。）
//   3. 一个工具一份数据，注册交给 registry，这里不判类型——没有硬编码 switch。
//   4. 不引 Effect/Schema：inputSchema 手写 JSON，运行时校验交给 registry 的 validateArgs（轻量版）。
//      对应 opencode 的 Schema.Struct + decode（tool.ts:111-129）。
//
// 与 opencode 的差异：工具 id 沿用 harness 自己的命名（read_file/run_command…，不重命名成
// read/bash），避免破坏 session 里已存的 tool_use 与第 3 课的 plan 白名单。

import type Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { dirname } from "path";
import { spawnSync } from "child_process";

/** 工具执行的规范返回：output 给模型，metadata 给 UI/审计（先轻量，只有 output 是必须） */
export interface ToolOutput {
  output: string;
  metadata?: Record<string, unknown>;
}

/** ⭐ 工具身份证：模型看到什么（id/description/inputSchema）+ 我们干什么（execute） */
export interface ToolDef {
  id: string;
  description: string;
  inputSchema: Anthropic.Tool["input_schema"];
  /** 真正干活。允许异步（webfetch 要 fetch）。 */
  execute(input: Record<string, unknown>): string | Promise<string>;
  /** 输出字节上限（默认 DEFAULT_MAX_OUTPUT_BYTES）；大输出工具可调大 */
  maxOutputBytes?: number;
}

/** ToolDef → Anthropic 协议形状（模型工具声明） */
export function toAnthropicTool(def: ToolDef): Anthropic.Tool {
  return { name: def.id, description: def.description, input_schema: def.inputSchema };
}

// ── 内置工具表（BUILTIN_TOOLS）───────────────────────────────────────────
// 对应 opencode 的 builtin 列表（registry.ts:226-244）的最小版。
// 工具输出治理统一交给 registry.execute 的 truncateOutput（删掉了原来各工具里零散的 slice 逻辑）。

export const BUILTIN_TOOLS: ToolDef[] = [
  {
    id: "read_file",
    description: "Read a file's contents. Use to examine existing files.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Path to the file" } },
      required: ["path"],
    },
    execute: (args) => {
      const path = args.path as string;
      if (!existsSync(path)) return `Error: File '${path}' not found.`;
      return readFileSync(path, "utf-8");
    },
    maxOutputBytes: 8000,
  },
  {
    id: "write_file",
    description: "Write or overwrite a file. Use to create or update files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
    execute: (args) => {
      const path = args.path as string;
      const content = args.content as string;
      mkdirSync(dirname(path) || ".", { recursive: true });
      writeFileSync(path, content, "utf-8");
      return `Successfully wrote ${Buffer.byteLength(content)} bytes to ${path}`;
    },
  },
  {
    id: "list_files",
    description: "List files in a directory. Use to explore project structure.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path, default is current" } },
      required: [],
    },
    execute: (args) => {
      const path = (args.path as string | undefined) ?? ".";
      if (!existsSync(path)) return `Error: Directory '${path}' not found.`;
      return readdirSync(path).slice(0, 50).join("\n");
    },
  },
  {
    id: "run_command",
    description: "Run a shell command and return its output.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string", description: "The command to execute" } },
      required: ["command"],
    },
    execute: (args) => {
      const command = args.command as string;
      const result = spawnSync(command, { shell: true, encoding: "utf-8", timeout: 30_000 });
      let output = result.stdout ?? "";
      if (result.stderr) output += "\n[stderr]\n" + result.stderr;
      return output;
    },
  },
  {
    id: "finish",
    description: "Call this when the task is complete. Provide a summary of what was done.",
    inputSchema: {
      type: "object",
      properties: { summary: { type: "string", description: "What was accomplished" } },
      required: ["summary"],
    },
    // finish 在 agent-loop 里被特判为收尾信号，不会走到 execute（见 loop/agent-loop.ts）。
    execute: () => "Task marked as complete.",
  },
];
