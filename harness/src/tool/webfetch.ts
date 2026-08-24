// tool/webfetch.ts —— 外部 HTTP 工具（第 5 课 §12.2，移植 opencode webfetch.ts 的最小版）
//
// 移植保留了 opencode 的骨架，砍掉了我们用不到的：
//   ✅ 保留：URL 校验（http/https）、浏览器 UA、Accept 头协商、5MB 双重体积闸、超时、
//            内容类型分流（图片告知 / HTML→文本）
//   ❌ 砍掉：权限 ctx.ask（#8 未落地）、Cloudflare 403 换 UA 重试（可后补）、
//            markdown 转换（turndown）与 attachments（#6）、timeout 参数（先固定 30s）
//
// 无重依赖：用 Node 18+ 全局 fetch + AbortSignal.timeout；HTML→文本用手写提取（skipDepth
// 思路同 opencode read.ts / webfetch.ts 的 extractTextFromHTML）。

import type Anthropic from "@anthropic-ai/sdk";
import type { ToolDef } from "./tool.js";

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
const TIMEOUT_MS = 30_000; // 30s

// 伪装 Chrome UA：很多站点会拒绝非浏览器 UA（opencode 同款）
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

/** 按 format 拼 Accept 头：告诉服务器"最想要什么，退而求其次给什么" */
function acceptFor(format: string): string {
  if (format === "html") return "text/html;q=1.0, */*;q=0.1";
  return "text/plain;q=1.0, text/html;q=0.8, */*;q=0.1"; // text 默认：优先纯文本，不行给 HTML 本地转
}

export const WEBFETCH_TOOL: ToolDef = {
  id: "webfetch",
  description:
    "Fetches content from a specific URL. Use when you need to retrieve or analyze a web page, " +
    "or to get current/up-to-date information that may be beyond your training data " +
    "(e.g. the latest news, prices, or product models). You must provide a fully-formed URL starting with http:// or https://. " +
    'format: "text" strips HTML tags (default), "html" returns raw HTML. Read-only, does not modify files.',
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch content from (must start with http:// or https://)" },
      format: {
        type: "string",
        description: 'Response format: "text" strips HTML (default), "html" returns raw HTML',
        enum: ["text", "html"],
      },
    },
    required: ["url"],
  },
  maxOutputBytes: 8000,
  async execute(input) {
    const url = input.url as string;
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return "Error: URL must start with http:// or https://";
    }
    const format = (input.format as string | undefined) ?? "text";

    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: acceptFor(format),
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error fetching ${url}: ${msg}`;
    }

    // 双重体积闸：先看 content-length 头（快），读完 body 再验实际字节（防头撒谎）
    const contentLength = Number(res.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_SIZE) {
      return "Error: response too large (exceeds 5MB limit)";
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_RESPONSE_SIZE) {
      return "Error: response too large (exceeds 5MB limit)";
    }
    if (!res.ok) {
      return `Error: HTTP ${res.status} ${res.statusText} fetching ${url}`;
    }

    const contentType = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (contentType.startsWith("image/")) {
      // 附件支持留 #6（FilePart/attachments）：先告知模型内容类型与大小
      return `Image fetched successfully (${contentType}, ${buf.byteLength} bytes). Image attachments not yet supported.`;
    }

    const text = buf.toString("utf-8");
    if (format === "html" || !contentType.includes("html")) return text;
    return extractTextFromHTML(text);
  },
};

/**
 * HTML → 纯文本：剥掉 script/style 等块的内容，块级标签换行，解常见实体，压空白。
 * 比 opencode 的 htmlparser2 状态机朴素（正则级），但对"给模型一段可读文本"足够。
 */
function extractTextFromHTML(html: string): string {
  const text = html
    // 1. 剥掉不贡献正文的块（非贪婪跨块匹配）
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<object[\s\S]*?<\/object>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // 2. 块级标签 → 换行，其余标签剥掉
    .replace(/<(br|p|div|li|h[1-6]|tr|section|article|header|footer|ul|ol|table|pre)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    // 3. 解常见 HTML 实体
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
  // 4. 逐行 trim + 去空行
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}
