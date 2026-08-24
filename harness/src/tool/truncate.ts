// tool/truncate.ts —— 工具输出治理：统一的字节上限截断（第 5 课 §七的极简版）
//
// opencode truncate.ts 做了行/字节双限 + 落盘 + "委托 explore"提示。我们只做最需要的
// "字节上限截断"：超限保留头部 + 明确告知截了多少字节。落盘（truncation dir）和
// "委托子代理"提示留到 #4（子代理）/ #6（上下文）落地后再补。

/** 截断结果：content 是模型最终看到的文本 */
export interface TruncateResult {
  content: string;
  truncated: boolean;
}

/**
 * 超 maxBytes 的文本截断到头部，并附截断说明。
 * 字节感知：不会把多字节 UTF-8 字符拦腰截断（回退到字符边界）。
 */
export function truncateOutput(text: string, maxBytes = 5000): TruncateResult {
  const total = Buffer.byteLength(text, "utf-8");
  if (total <= maxBytes) return { content: text, truncated: false };

  const buf = Buffer.from(text);
  let cut = maxBytes;
  // 回退到合法的 UTF-8 连续字节（0b10xxxxxx）之前，避免截断成乱码
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;

  return {
    content: `${buf.subarray(0, cut).toString("utf-8")}\n\n...${total - cut} bytes truncated (total ${total} bytes)...`,
    truncated: true,
  };
}
