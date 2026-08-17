// index.ts —— CLI 入口（对应学习地图 阶段 3 的 cli 包，先做最小版）
//
// 用法: npx tsx src/index.ts "你的任务"

import { agentLoop } from "./loop.js";

const task = process.argv[2] ?? "List the files in the current directory";
console.log(`Task: ${task}\n`);

const result = await agentLoop(task);
console.log(`\n${"=".repeat(60)}`);
console.log(`FINAL: ${result}`);
