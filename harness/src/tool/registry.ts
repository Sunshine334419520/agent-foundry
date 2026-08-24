// tool/registry.ts —— 工具注册表（第 5 课 §三/§四/§五落地）
//
// 对应 opencode tool/registry.ts + tool/tool.ts 的 wrap：
//   1. 注册：内置 + 自定义汇入一张表，all() 合并（没有硬编码 switch）。
//   2. 注入：toolsFor(agent) 按 agent 工具白名单裁剪（第 3 课的 resolveTools 挪到这里），
//      finish 强制兜底（对应 opencode Truncate.GLOB 兜底 + §五.1 的按场景过滤）。
//   3. 统一执行包装 execute()：查 def → validateArgs 校验（失败给"请重写"措辞，
//      对应 opencode 的 InvalidArgumentsError，tool.ts:24-34）→ 跑 execute → truncateOutput
//      （统一治理，对应 §四 wrap 的第三步）。
//
// 刻意不做：按 model 过滤（apply_patch/edit 分流）、插件钩子、动态描述（describeTask）——
// 用到再加。

import type Anthropic from "@anthropic-ai/sdk";
import type { Agent } from "../agent/agent.js";
import { BUILTIN_TOOLS, toAnthropicTool, type ToolDef } from "./tool.js";
import { WEBFETCH_TOOL } from "./webfetch.js";
import { WEBSEARCH_TOOL } from "./websearch.js";
import { truncateOutput } from "./truncate.js";

const DEFAULT_MAX_OUTPUT_BYTES = 5000;

/** 轻量参数校验：按 inputSchema 检查 required + 字段类型。返回错误文案或 null。 */
function validateArgs(schema: Anthropic.Tool["input_schema"], args: unknown): string | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return "arguments must be an object";
  }
  const rec = args as Record<string, unknown>;
  for (const name of schema.required ?? []) {
    if (rec[name] === undefined) return `missing required field "${name}"`;
  }
  // SDK 的 input_schema.properties 是松散类型，这里按我们关心的字段显式收窄
  const props = (schema.properties ?? {}) as Record<string, { type?: string } | undefined>;
  for (const [name, value] of Object.entries(rec)) {
    const prop = props[name];
    if (!prop) continue; // 多余字段容忍（对应 opencode additionalProperties 默认行为）
    if (prop.type === "string" && typeof value !== "string") return `field "${name}" must be a string`;
    if (prop.type === "number" && typeof value !== "number") return `field "${name}" must be a number`;
    if (prop.type === "boolean" && typeof value !== "boolean") return `field "${name}" must be a boolean`;
    if (prop.type === "array" && !Array.isArray(value)) return `field "${name}" must be an array`;
  }
  return null;
}

export class ToolRegistry {
  private readonly byId = new Map<string, ToolDef>();

  constructor(builtins: ToolDef[]) {
    for (const tool of builtins) this.byId.set(tool.id, tool);
  }

  /** 全部工具（内置 + 自定义） */
  all(): ToolDef[] {
    return [...this.byId.values()];
  }

  /** 按 id 取工具定义（agent-loop 的 finish 特判不查它） */
  get(id: string): ToolDef | undefined {
    return this.byId.get(id);
  }

  /**
   * 按 agent 白名单裁剪 → 模型工具声明。
   *   tools 未定义 = 全开；给定数组 = 只给白名单里的工具；finish 强制兜底（收尾信号不能被剪掉）。
   */
  toolsFor(agent: Agent): Anthropic.Tool[] {
    const defs = this.defsFor(agent);
    return defs.map(toAnthropicTool);
  }

  private defsFor(agent: Agent): ToolDef[] {
    if (!agent.tools) return this.all();
    const keep = new Set([...agent.tools, "finish"]);
    return this.all().filter((t) => keep.has(t.id));
  }

  /**
   * 统一执行包装：查 def → 校验 → execute → 截断。
   * 未知工具 / 参数非法都返回"请重写"措辞（模型自愈），而不是抛异常打断整个 loop。
   */
  async execute(id: string, args: Record<string, unknown>): Promise<string> {
    const def = this.get(id);
    if (!def) {
      const available = this.all().map((t) => t.id).join(", ");
      return `Unknown tool '${id}'. Please rewrite your tool call to use one of: ${available}`;
    }
    const err = validateArgs(def.inputSchema, args);
    if (err) {
      return `The ${id} tool was called with invalid arguments: ${err}.\nPlease rewrite the input so it satisfies the expected schema.`;
    }
    let output: string;
    try {
      output = await def.execute(args);
    } catch (e) {
      output = `Error executing ${id}: ${e instanceof Error ? e.message : String(e)}\nPlease try a different approach.`;
    }
    return truncateOutput(output, def.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES).content;
  }
}

/** 组合根：内置 + webfetch + websearch 汇成一张注册表（agent-loop 和 CLI 共用这一份） */
export const toolRegistry = new ToolRegistry([...BUILTIN_TOOLS, WEBFETCH_TOOL, WEBSEARCH_TOOL]);
