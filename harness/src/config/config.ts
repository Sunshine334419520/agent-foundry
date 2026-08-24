// config/config.ts —— 配置加载（对应学习地图 阶段 6 模型接入的地基）
//
// 和 Python demo 同一个思路：直接读 ~/.claude/settings.json 的 env 块，
// 不复制 key 到终端。优先级：配置文件 > 进程环境变量 > 代码默认值。

import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface LLMConfig {
  /** API 服务器地址（DeepSeek 的 Anthropic 兼容端点） */
  baseURL?: string;
  /** 认证 token（DeepSeek key） */
  authToken?: string;
  /** 模型名 */
  model: string;
  /** 模型上下文限制（第 6 课：token 预算的地基） */
  modelLimit: ModelLimit;
  /** Prompt caching 开关（第 7 课：默认开，同 opencode "auto" 策略——5 分钟内复用一次就回本） */
  cache?: boolean;
}

/** 模型 token 能力表（对应 opencode Provider.Model.limit）。按实际模型调 input 上限。 */
export interface ModelLimit {
  /** 输入上下文上限（token）。想换模型就改这里或设 ANTHROPIC_MODEL。 */
  input: number;
  /** 单次最大输出 token——用于"预留输出空间"（§二 usable 的 reserved） */
  maxOutputTokens: number;
}

/** 默认值：按 deepseek-v4-flash 的常见上下文估算；不准就改 loadConfig 或 env。 */
const DEFAULT_MODEL_LIMIT: ModelLimit = { input: 64_000, maxOutputTokens: 8_192 };

export function loadConfig(): LLMConfig {
  const configPath = join(homedir(), ".claude", "settings.json");
  let envFromFile: Record<string, string> = {};
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      envFromFile = raw?.env ?? {};
    } catch {
      // 读不到就当没有，交给环境变量兜底
    }
  }

  const pick = (key: string, fallback?: string) =>
    envFromFile[key] ?? process.env[key] ?? fallback;

  return {
    baseURL: pick("ANTHROPIC_BASE_URL"),
    authToken: pick("ANTHROPIC_AUTH_TOKEN"),
    // settings.json 里没有 ANTHROPIC_MODEL（那套 DEFAULT_* 是 Claude Code 内部路由），
    // 所以默认值就是实际用的模型，想换模型改这里或设 ANTHROPIC_MODEL。
    model: pick("ANTHROPIC_MODEL", "deepseek-v4-flash"),
    modelLimit: {
      input: Number(pick("ANTHROPIC_CONTEXT_LIMIT", String(DEFAULT_MODEL_LIMIT.input))),
      maxOutputTokens: DEFAULT_MODEL_LIMIT.maxOutputTokens,
    },
    // 缓存默认开；ANTHROPIC_CACHE=false 关闭（对标 opencode cachePolicy "auto" / "none"）
    cache: pick("ANTHROPIC_CACHE", "true") !== "false",
  };
}

// ── 简易成本估算（学习用，诚实起见：未知模型显示 "—"）──
// 填你实际用到的模型价格即可，单位 ¥/百万 token：
//   PRICING = { "deepseek-v4-flash": { input: 2, output: 6, cacheRead: 1, cacheWrite: 3 } }
// 没有价格的模型 estimateCost 返回 null，UI 显示 "费用 —（未配置价格）"。
export const PRICING: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {};

export function estimateCost(
  model: string,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number | null {
  const p = PRICING[model];
  if (!p) return null;
  return (
    (usage.input * p.input) / 1_000_000 +
    (usage.output * p.output) / 1_000_000 +
    (usage.cacheRead * p.cacheRead) / 1_000_000 +
    (usage.cacheWrite * p.cacheWrite) / 1_000_000
  );
}
