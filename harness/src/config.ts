// config.ts —— 配置加载（对应学习地图 阶段 6 模型接入的地基）
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
}

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
    // 所以默认值就是实际用的模型，想换模型改这里。
    model: pick("ANTHROPIC_MODEL", "deepseek-v4-flash"),
  };
}
