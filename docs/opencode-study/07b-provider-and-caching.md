# 07b · Provider 抽象 / 统一接口 / Prompt Caching / 用量统计

> 日期：2026-08-23
> 配套源码：`packages/llm/`（`llm.ts`、`route/`、`providers/`、`protocols/`、`cache-policy.ts`）、`packages/opencode/src/provider/provider.ts`
> 定位：第 7 课"模型接入 / 流式"的**后半部分**。流式（SSE→语义事件、一条流两个消费者）已在 [07-streaming.md](07-streaming.md) 拉前深挖完成；本文件补上 **provider 抽象 / 统一接口 / prompt caching / 用量统计** 四个理论点，并给出 harness 的落地对照。

## 一句话总结

**opencode 把"模型接入"拆成两层：`packages/llm` 是 provider 无关的 LLM 客户端库（只认统一的 `LLMRequest` → `LLMEvent/LLMResponse`），`packages/opencode` 只在上面选 provider、配模型。通往各家 API 的路由被拆成四个正交件——Protocol（说哪种 API 语言）/ Endpoint（发去哪）/ Auth（怎么认证）/ Framing（怎么切流），于是换供应商 = 换一个 Route 引用，应用层一行不改。prompt caching 则是一条独立策略：在 system / tools / 最新 user 消息的边界上打 `cache_control` 断点，让一轮 user 消息爆发出的十几轮 tool 往返全部命中缓存前缀。**

---

## 一、两条抽象层的分工

### 1.1 `packages/llm`：provider 无关的客户端库（只懂"统一形状"）

它定义唯一入口 `LLMClient.generate / stream`，吃一个规范化的 `LLMRequest`：

```
LLMRequest（统一请求模型）
├─ system:  SystemPart[]           ← 不是 string，是 content block 数组（能带 cache_control）
├─ messages: Message[]             ← 也是 parts 数组，不是裸文本
├─ tools:    ToolDefinition[]
├─ toolChoice / generation / providerOptions / http
└─ model:    Model                 ← 每个 Model 绑定一个 Route（provider + route）
```

调用方（loop / 摘要 agent）**永远只跟这个形状打交道**，看不到任何 provider 原生格式。

### 1.2 `packages/opencode`：应用层（只做"选 provider、配模型"）

`session/llm.ts` + `provider/provider.ts` 在 llm 库之上组装：读 config、查 auth、决定默认模型、把 model 路由到具体 Route。应用层的"知识"是 **provider 生态**（OpenAI/Anthropic/Bedrock/Gemini/… 各家 baseURL、capabilities、cost），不是协议本身。

**这是分层的核心价值**：协议怎么说话（`packages/llm`）跟"我该跟谁说话"（`packages/opencode`）解耦。

---

## 二、Route = 四个正交件（统一接口的物理结构）

`route/client.ts` 的 `make()` 注释说得最清楚：**一次部署 = Protocol + Endpoint + Auth + Framing**，再加可选 headers。

| 件 | 职责 | 例子 |
|---|---|---|
| **Protocol** | "我讲的是哪种 API 的语言"：公共 LLMRequest → provider-native body（`body.from`）；stream 帧 → 统一 LLMEvent（`stream.step` 状态机） | `anthropic-messages.ts`（Messages API 含 content blocks）、`openai-chat.ts`、`openai-responses.ts`、`gemini.ts`、`bedrock-converse.ts` |
| **Endpoint** | "发去哪"：baseURL + path（path 可以是函数，把 model id/region 嵌进 URL，Bedrock/Gemini 用） | `https://api.anthropic.com/v1` + `/messages` |
| **Auth** | "怎么认证"：api-key / oauth / 自定义 header | `Authorization: Bearer …` |
| **Framing** | "怎么把字节流切成帧"：SSE / AWS event stream | `Framing.sse`：UTF-8 → SSE channel → 丢空行和 `[DONE]` |

### 2.1 最关键的一句话：Protocol 不是部署

> DeepSeek / TogetherAI / Cerebras 都复用 `OpenAIChat.protocol`，只需换 Endpoint/Auth，不用 fork 300 行。

**"说哪种 API 语言"和"连到哪个服务"是两码事。** 这是 Route 拆分的全部意义——**换供应商 = 换 Route 引用（或 `route.with({ endpoint, auth })` 打补丁），应用层零改动**。这正是"统一接口"名字的来源。

### 2.2 数据流：一次 request 的编译 → 执行

`LLMClient.stream/generate` 下钻到 `Route.streamPrepared`，管线如下：

```
LLMRequest
  └─ compile():                              （route/client.ts 的 compile，纯编译，不发请求）
      ├─ applyCachePolicy(resolveRequestOptions(request))   ← caching 注入在这层（见 §四）
      ├─ route.body.from(request)            ← Protocol：公共形状 → provider-native body
      │    └─ validateWith(body.schema)      ← Schema 校验，不合法不发
      └─ route.prepareTransport(body, request)  ← Auth/headers/framing 准备好
  └─ transport.frames(...)                   ← 发出，得到字节流
  └─ Stream.mapEffect(decodeEvent)           ← Framing：字节 → 帧 → Schema 解码成 Event
  └─ protocol.stream.step(state, event)      ← Protocol：native Event → 统一 LLMEvent 流
  └─ 状态机在每帧上累积（initial/step/onHalt）
```

**generate 就是 stream 的折叠**（client.ts `generateWith`）：`stream(...).pipe(Stream.runFold(LLMResponse.empty, LLMResponse.reduce))`——**流式和非流式共享同一套事件语义**，`generate` 内部只是把 `finish` 之后的状态折成 `LLMResponse`。这跟 07-streaming.md 讲过的"一条流两个消费者"是同一个道理的另一面。

### 2.3 RequestExecutor：HTTP 层也要有讲究

`route/executor.ts`（385 行）负责**执行**，值得抄的点：

- **敏感信息 redact**：发送前收集 Authorization/api-key/token 等 header 与 query 的真实值，请求/响应体、日志里一律替换成 `<redacted>`——provider 偶发把 token 回显在错误体里，不会漏进日志。
- **重试 + 退避**：429/5xx 可重试，尊重 `Retry-After` 头（毫秒/秒/日期三种格式），指数退避 + 抖动。我们 harness 的 `llm/retry.ts` 已经移植了这个思想。
- **错误分类**：HTTP status + 响应体模式 → `ContentPolicyReason` / `AuthenticationReason` / `RateLimitReason`（带完整 rate-limit 详情）/ `InvalidRequestReason`（body 里命中 context-overflow → classification）…… 把"provider 抛来的一团 HTTP"翻译成语义错误，供上层 halt 决策。

---

## 三、Model 的元数据：capabilities / cost / limit

`provider/provider.ts:965-1050` 定义了 provider 生态的数据形状：

```ts
Model {
  id, providerID, api, name, family,
  capabilities: { temperature, reasoning, attachment, toolcall,
                  input/output: { text, audio, image, video, pdf }, interleaved },
  cost: { input, output, cache: { read, write }, tiers, experimentalOver200K },
  limit: { context, input?, output },
  status, options, headers, release_date, variants,
}
```

**关键洞察：cost 是 Model 元数据，不是代码里写死的表格。** 每家 provider 的输入/输出/缓存读/缓存写定价、甚至 200K+ 的阶梯价，都作为数据挂在 Model 上。用量统计 = `usage tokens × model.cost` 的纯计算。

> 对照 harness：我们 `config/config.ts` 的 `PRICING` 表是**代码里的静态常量**（且现在是空的），opencode 则是 **Model 数据上的一等公民**。这是"用量统计"从"能算"到"算得对、算得全"的差距。

---

## 四、Prompt Caching：一条独立策略，自动打断点

`llm/cache-policy.ts`（105 行）是 caching 的全部逻辑，结构极简：

### 4.1 默认策略 "auto"（默认开）

```
AUTO = { tools: true, system: true, messages: "latest-user-message" }
```

编译时（`applyCachePolicy`，在 `compile()` 里、body 构造**之前**）往三处打 `CacheHint`（`{ type: "ephemeral", ttlSeconds? }` → 落到 Anthropic 协议就是 `cache_control: { type: "ephemeral", ttl: "5m"|"1h" }`）：

| 位置 | 打的断点 |
|---|---|
| tools | **最后一个 tool definition** 上 |
| system | **最后一个 system part** 上 |
| messages | **最新一条 user 消息**的最后一个 text block 上 |

### 4.2 为什么是这三个位置（注释里直说了）

> the latest user message stays put while a single turn explodes into many assistant/tool round-trips, so caching at that boundary lets every intra-turn API call hit the prefix.

**一轮 user 消息会在 agent loop 里爆成十几轮 assistant/tool 往返。** 这些往返的请求前缀（system + tools + 旧的 assistant/tool 结果）在每一轮里都是相同的——在 system/tools/最新 user 三处打断点，就保证**循环里的每一次 API 调用都命中同一个缓存前缀**，只有新到的 tool result 增量算钱。这是"工具循环"场景最省钱的打法。

### 4.3 只对尊重内联 hint 的协议生效

```ts
const RESPECTS_INLINE_HINTS = new Set(["anthropic-messages", "bedrock-converse"])
```

OpenAI 是**隐式前缀缓存**（不靠请求里打标记），Gemini 用隐式 + 带外 CachedContent——对它们发 hint 无害但无意义，直接跳过整个策略。

### 4.4 为什么默认开：账是算得清的

> Anthropic 5m-cache write 是 1.25x base，read 是 0.1x base——**5 分钟内哪怕只复用一次就回本**。

写入缓存多付 25%，读缓存省 90%，而 tool 循环天然在 5 分钟内反复复用同一前缀。默认开是数学上稳赢的选择。

---

## 五、对照我们的 harness：差距与落点

### 5.1 已经有的

| 层 | harness 现状 |
|---|---|
| 统一接口（雏形） | `LLM.generate/stream` 只吃 `LLMGenerateInput`，返回 `LLMResponse/StreamEvent`——loop 确实不碰 SDK |
| 流式语义事件 | ✅ 07 课完成：SSE → 11 种 StreamEvent，`llm/stream.ts` 纯折叠 |
| 重试/退避 | ✅ `llm/retry.ts`：429/5xx/消息模式可重试，尊重 Retry-After |
| 用量统计（雏形） | `Usage{input,output,cacheRead,cacheWrite}` + `estimateCost`，但 `PRICING` 是空表 |
| 上下文限制 | `config.ts` modelLimit（第 6 课） |

### 5.2 缺的（第 7 课 D 步候选）

| 缺口 | opencode 做法 | harness 落点 |
|---|---|---|
| **Prompt caching** | `cache_control` 断点：system 末块 / 最后一个 tool / 最新 user 消息 | `llm.ts` 请求构造时注入断点（config 加开关，默认开） |
| **provider 抽象** | Route 四正交件：Protocol/Endpoint/Auth/Framing | 最小版：定义 `Provider` 接口（generate/stream），LLM 委托；保留 Anthropic-compatible 实现 |
| **用量/成本数据化** | cost 挂在 Model 元数据 | PRICING 从空表填起来；turn-end 显示缓存命中率 |

### 5.3 最省最优的 D 步顺序

1. **caching 先行**——投入最小、收益最直接（真省钱）、且是地图上"随 #6 补"一直欠着的。在 `llm.ts` 里：system 改成 content block 数组并在末块打 `cache_control`、tools 最后一个打、最新 user 消息末 text 块打；config 加 `cache: boolean` 开关（默认开）。
2. **provider 接口抽象**——把 `LLM` 从"一个焊死的 Anthropic 封装"提成"实现 `Provider` 接口"，为将来接别的端点留缝。
3. **用量数据化**——填 `PRICING` 真实价格，`/usage` 或 turn-end 显示缓存读/写占比。

---

## 六、思考题（B 步讨论）

1. 为什么 caching 断点必须打在 system/tools/**最新 user 消息**，而不是打在"第一条 user 消息"？（提示：agent loop 里一轮 user 会爆成多少轮往返？每轮往返里前缀变不变？）
2. `generate` 内部是"stream + runFold"——那 `generate` 和 `stream` 到底是不是两套逻辑？这对我们 harness 的 `generate`（摘要 agent 用）意味着什么？（提示：摘要 agent 现在走的是 `generate`，如果换成 `stream` 折叠，行为一致吗？）
3. Provider 拆分（Protocol/Endpoint/Auth/Framing）里，哪一件是"我们换端点时**最常**要换的"？哪一件是"换供应商时才换的"？（提示：DeepSeek 换 Anthropic 端点，改的是 Endpoint+Auth 还是 Protocol？）
4. 我们 harness 现在 system 传的是 `string`。要打 cache_control 断点，为什么必须改成 content block 数组？（提示：`cache_control` 是加在"哪个粒度"上的？）
5. opencode 对 OpenAI 系不发缓存 hint（隐式前缀缓存），但 DeepSeek 的 Anthropic 兼容端点是显式 cache_control 还是隐式？这对我们的 caching 实现意味着什么？（提示：DeepSeek 走 `/v1/messages`，是 anthropic-messages 协议）
