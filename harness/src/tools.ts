// tools.ts —— 工具系统（对应学习地图 阶段 4，这里先做最小版）
//
// TOOLS = LLM 的"说明书"（纯数据）；executeTool = 真正干活的手脚（我们的代码）。

import type Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { dirname } from "path";
import { spawnSync } from "child_process";

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "read_file",
    description: "Read a file's contents. Use to examine existing files.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Path to the file" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write or overwrite a file. Use to create or update files.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_files",
    description: "List files in a directory. Use to explore project structure.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path, default is current" } },
      required: [],
    },
  },
  {
    name: "run_command",
    description: "Run a shell command and return its output.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string", description: "The command to execute" } },
      required: ["command"],
    },
  },
  {
    name: "finish",
    description: "Call this when the task is complete. Provide a summary of what was done.",
    input_schema: {
      type: "object",
      properties: { summary: { type: "string", description: "What was accomplished" } },
      required: ["summary"],
    },
  },
];

export function executeTool(name: string, args: Record<string, unknown>): string {
  try {
    switch (name) {
      case "read_file": {
        const path = args.path as string;
        if (!existsSync(path)) return `Error: File '${path}' not found.`;
        let content = readFileSync(path, "utf-8");
        if (content.length > 8000) content = content.slice(0, 8000) + "\n... [truncated]";
        return content;
      }
      case "write_file": {
        const path = args.path as string;
        const content = args.content as string;
        mkdirSync(dirname(path) || ".", { recursive: true });
        writeFileSync(path, content, "utf-8");
        return `Successfully wrote ${Buffer.byteLength(content)} bytes to ${path}`;
      }
      case "list_files": {
        const path = (args.path as string | undefined) ?? ".";
        if (!existsSync(path)) return `Error: Directory '${path}' not found.`;
        return readdirSync(path).slice(0, 50).join("\n");
      }
      case "run_command": {
        const command = args.command as string;
        const result = spawnSync(command, { shell: true, encoding: "utf-8", timeout: 30_000 });
        let output = result.stdout ?? "";
        if (result.stderr) output += "\n[stderr]\n" + result.stderr;
        if (output.length > 5000) output = output.slice(0, 5000) + "\n... [truncated]";
        return output;
      }
      case "finish":
        return "Task marked as complete.";
      default:
        return `Error: Unknown tool '${name}'. Available: read_file, write_file, list_files, run_command, finish`;
    }
  } catch (e) {
    return `Error executing ${name}: ${e}\nPlease try a different approach.`;
  }
}
