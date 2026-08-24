// tool/websearch.ts —— 网页搜索工具（第 5 课 §12.2 补的"另一半"）
//
// webfetch 是"给 URL 抓内容"，websearch 是"给查询词找 URL"——两个职责互补：
//   搜索 → websearch(query) → 候选 URL 列表
//   打开 → webfetch(url)   → 页面内容
// 没有 websearch，模型只能盲猜 URL（"华为最新手机型号"这种问题无从下手）。
//
// 数据源：DuckDuckGo HTML 端点（免费、无需 API key）。代价是结果页是 HTML，要解析
// （web-result 块里的 result__a = 标题+链接，result__snippet = 摘要）。DDG 有时反爬
// 返回 anomaly 页，此时结果为空/报错——免费方案的可接受代价（opencode 用的是
// Exa/Parallel 等付费搜索 API，我们学习阶段用 DDG 够了）。

import type { ToolDef } from "./tool.js";

const DDG_ENDPOINT = "https://html.duckduckgo.com/html/";
const TIMEOUT_MS = 30_000;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * 解析 DDG 结果页 HTML → 结果列表。
 * 不按 div 切块（result__snippet 也是 div，会被切断）——而是全局匹配两类锚点，
 * 再按文档位置配对：每条 result__a 之后最近的一条 result__snippet 是它的摘要。
 */
export function parseDdgHtml(html: string): SearchResult[] {
  const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  const anchors: { index: number; href: string; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html))) {
    const title = stripTags(m[2]);
    if (title) anchors.push({ index: m.index, href: m[1], title });
  }
  const snippets: { index: number; text: string }[] = [];
  while ((m = snippetRe.exec(html))) {
    const text = stripTags(m[1]);
    if (text) snippets.push({ index: m.index, text });
  }

  const results: SearchResult[] = [];
  for (const a of anchors) {
    const snip = snippets.find((s) => s.index > a.index);
    results.push({ title: a.title, url: decodeDdgUrl(a.href), snippet: snip ? snip.text : "" });
  }
  return results;
}

/** DDG 结果是重定向链接（//duckduckgo.com/l/?uddg=<真实URL>&rut=...），解开它 */
function decodeDdgUrl(href: string): string {
  const decoded = decodeEntities(href);
  const m = decoded.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  return decoded.startsWith("//") ? "https:" + decoded : decoded;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

export const WEBSEARCH_TOOL: ToolDef = {
  id: "websearch",
  description:
    "Searches the web for a query and returns a list of results (title, URL, snippet). " +
    "Use when you need current/up-to-date information that may be beyond your training data " +
    "(e.g. latest news, prices, product models), or when you don't know which URL to open. " +
    "After searching, use webfetch to open the best result and read its full content.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
      maxResults: { type: "number", description: "Max results to return (default 5, max 10)" },
    },
    required: ["query"],
  },
  maxOutputBytes: 4000,
  async execute(input) {
    const query = (input.query as string | undefined)?.trim();
    if (!query) return "Error: query is required";
    const maxResults = Math.min(Math.max(Math.floor((input.maxResults as number | undefined) ?? 5), 1), 10);

    let html: string;
    try {
      const res = await fetch(`${DDG_ENDPOINT}?q=${encodeURIComponent(query)}`, {
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "text/html",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return `Error: HTTP ${res.status} ${res.statusText} searching "${query}"`;
      html = await res.text();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `Error searching "${query}": ${msg}`;
    }

    const results = parseDdgHtml(html).slice(0, maxResults);
    if (results.length === 0) {
      return `No results found for "${query}" (DuckDuckGo may be rate-limiting or blocking this request).`;
    }
    return results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join("\n\n");
  },
};
