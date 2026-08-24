# 09 · MCP（Model Context Protocol）—— 给 Agent 一个"通用插座"

> 日期：2026-08-24
> 定位：**纯理论篇**。本课按要求**不读 opencode 的 `mcp/` 代码**——MCP 是一个**协议**，它活在规范文本里，不在任何一家的实现里。学它 = 学"为什么要有这个协议、它规定了什么、边界在哪里"。
> 资料来源：本文凭作者对 MCP 规范的既有知识写成（用户选择不抓官网）。凡是**具体到版本号/方法名/错误码**这种"会随规范版本漂移"的细节，文内用 `⚠` 标出，并在文末"待核对清单"集中列明，你之后对官方规范（spec.modelcontextprotocol.io）逐一校准即可。**概念与设计逻辑可信度高，字面细节以官方当前版为准。**
> 前置：#5 Tools（工具 schema/注册/执行）、#8 权限（MCP 工具的准入边界就是它的门）——这两课给 MCP 的下半场铺路。

## 一句话总结

**MCP 是一个"给 AI 应用提供上下文与能力"的**开放协议**：它把"AI 应用 ↔ 各种数据源/工具"之间混乱的 N×M 个私有集成，标准化成"N 个客户端 + M 个服务端"的解耦结构——Host（编排+守门）装 Client（一个 Client 对应一个 Server 的通道），Server（提供 `tools`/`resources`/`prompts` 三类能力）上报自己能干什么，Host 侧再由**应用自己的权限系统**决定模型能用什么。协议解决"怎么装、怎么连、怎么发现、怎么调"；**"该不该用"永远留给 Host 的人类和权限层去裁决。**

更直白地讲：**MCP 是"Agent 世界的 USB-C"。** 没有它，每个 AI 工具（编辑器、CLI、Agent 平台）都要为每个数据源（数据库、文件系统、GitHub、浏览器）单独写一套胶水代码；有了它，数据源只要实现一次 Server，任何实现了 Client 的 Host 都能用。

---

## 一、为什么会有 MCP：N×M 问题

在 MCP 之前，"让 AI 应用能用上外部工具和数据"是一个**每家自建**的工程：

- OpenAI 有 function calling、Anthropic 有 tool use、各家 SDK 各有自己的工具定义——**都对，都私有**；
- 一个编辑器要塞集成（文件、GitHub、Jira、数据库）→ 编辑器团队为每个源写 adapter；一个数据库配上 N 个 AI 应用 → 数据库团队为每个应用写 SDK 适配。

这就是经典的 **N×M 集成爆炸**：

```
       AI 应用               数据源/工具
   ┌─────────────┐        ┌─────────────┐
   │  应用 A     │────××──▶│   源 1      │   每一条 ×× 都是：私有协议 + 各自版本
   │  应用 B     │────××──▶│   源 2      │   + 各自权限 + 各自 SDK
   │  应用 C     │────××──▶│   源 3      │   = N×M 条胶水，双边都在重复造
   └─────────────┘        └─────────────┘
```

MCP 把中间的"每个 ××"抽成一个**标准协议**：

```
   AI 应用(实现 Client)               数据源(实现 Server)
   ┌──────────────┐   stdio/HTTP/WS  ┌──────────────┐
   │  应用 A: Host │── Protocol ─────▶│   源 1: Server │
   │  应用 B: Host │── Protocol ─────▶│   源 2: Server │
   │  应用 C: Host │── Protocol ─────▶│   源 3: Server │
   └──────────────┘                  └──────────────┘
   = N 个 Client + M 个 Server，接线成本从 N×M 降到 N+M
```

这个"标准"规定的不是**业务逻辑**，而是三件协议层的事：
1. **怎么连接**（传输、握手、版本协商）；
2. **怎么描述能力**（tools/resources/prompts 的 schema）；
3. **怎么调用/读取/订阅**（方法名、请求/响应/通知、错误码）。

业务逻辑（我的工具到底干嘛）留在 Server 里；调用策略（模型能不能用、要不要问人）留在 Host 里。**MCP 故意只做前者，不碰后者**——这是它和"一个全能的 agent 框架"最本质的分界。

---

## 二、架构三角色：Host / Client / Server

### 2.1 一张结构图

```
                    ┌─────────────────────────────────┐
                    │            Host 应用             │
                    │  （编辑器 / CLI / Agent 平台）    │
                    │                                  │
                    │   ┌─────────┐  ┌─────────┐       │
                    │   │ Client A│  │ Client B│  ...  │
                    │   └────┬────┘  └────┬────┘       │
                    └────────┼───────────┼─────────────┘
                             │ 传输       │ 传输
                     ┌───────▼────┐  ┌───▼────────┐
                     │ Server A   │  │ Server B   │
                     │ tools      │  │ tools      │
                     │ resources  │  │ resources  │
                     │ prompts    │  │ prompts    │
                     └────────────┘  └────────────┘
```

### 2.2 三个角色各守什么

| 角色 | 是什么 | 责任 |
|---|---|---|
| **Host**（主机） | 用户眼前的 AI 应用（IDE、CLI、Agent 框架） | **编排 + 守门**。装多个 Client；决定把哪些 Server 的能力暴露给模型；在把工具交给模型前过**自己的权限系统**；把资源按需塞进上下文 |
| **Client**（客户端） | Host 内部的连接组件 | 与**一个** Server 建一条连接（一个传输）；发现/调用其能力。**N 个 Server = N 个 Client** |
| **Server**（服务端） | 提供能力的进程/服务 | 声明自己的能力集合；执行 tools、提供 resources、返回 prompts；可选向 Host 请求采样 |

三个要点：

1. **"Host 持有 Client，Host 与 Server 是多对多"**。一个 Claude Code 会话可能就是 Host（它里面每个 MCP server 挂一个 Client）；一个 Server 可以被多个 Host 同时连。
2. **Server 不决定"模型看到什么"**。Server 只声明"我有这些工具"；**把哪些工具秀给模型、允许哪些执行，是 Host 单方面的事**。这正是 MCP 与"一个万能 agent 框架"又一个分界：协议没有全局裁决权，权力在最有话语权的一方（用户所在的 Host）。
3. **本地 vs 远程**：利用 stdio 传输的 Server 与用户同信任域（跑在本机进程里）；HTTP/WebSocket 的 Server 在网络上（第三方），是**不可信**的——Host 对此要有不同的准入/授权策略（§六）。

---

## 三、三种能力原语：tools / resources / prompts

MCP 最核心的设计是把"Server 能给模型什么"**按"谁来发起"**切成三类（而不是一个大杂烩的"万物皆是工具"）：

| 原语 | 本质 | 谁发起 | 类比 |
|---|---|---|---|
| **Tools**（工具） | 可被调用的**动作**（有副作用），带输入/输出 schema | **模型**自主调用 | 函数调用 |
| **Resources**（资源） | 可被读取的**数据**（只读），按 URI 寻址 | **Host** 主动塞进上下文 | 文件 / 文档 / 数据库 schema |
| **Prompts**（提示词） | 可被复用的**消息模板**（带参数占位） | **用户**主动触发 | 斜杠命令 / 快捷键 |

### 3.1 Tools：模型发起的动作

- Server 暴露：`name` + `description` + `inputSchema`（JSON Schema，就是 #5 课我们 harness 里那份 tool schema 的来源）+ 可选的 `outputSchema`、`annotations`（如 `readOnlyHint`/`destructiveHint` 之类，纯提示）。
- Host 把"允许的"工具 publish 给模型（拿 #8 的规则过一遍），模型发 `tools/call` → Server 执行 → 返回**结构化的 content**（text/image/audio/resource 块 + `isError` 标志）。
- **tools 是"发生改变"的地方**（写文件、发请求、改状态），所以它是权限争议的核心。会变：`notifications/tools/list_changed` 通知 Host"工具集变了，请重新拉取"。
- ⚠ 方法名：`tools/list`、`tools/call`、`notifications/tools/list_changed`。

### 3.2 Resources：Host 塞进上下文的只读数据

- 资源是**数据**（文档、schema、配置、代码片段），用归一化的 URI 寻址（`file://...`、`db://schema/users`…）。
- **重要语义：Resources 不是模型调用的**——是 **Host 决定何时把某资源读进上下文**（比如用户 @ 一个文件、任务相关时主动带）。Server 端能力只有 `resources/list`、`resources/read`、`resources/templates/list`（参数化路径模板）、`resources/subscribe`（订阅变更）。
- 为什么单独列一类？因为**"工具是异变的，资源是稳定的"**：把数据当资源，Host 可以按需注入、缓存、订阅变更，而不用把"读数据"重写成一次次工具调用。这对上下文管理（#6）是福星——**数据进上下文是 Host 的战略决策，不该交给模型瞎调**。
- ⚠ 方法名：`resources/list`、`resources/read`、`resources/templates/list`、`resources/subscribe`、`notifications/resources/list_changed`、`notifications/resources/updated`。

### 3.3 Prompts：用户发起的模板

- Server 提供用户可复用的**消息模板**（一组带头部占位符的 message，如 "整理这个项目的技术债"→ 预置 system 指令 + user 提问）。
- 只能**用户**触发（等价于"在正确的时间把正确的话丢进对话"）——模型不能自己 invoke 一个 prompt。Host 把它实现成类似斜杠命令的入口。
- ⚠ 方法名：`prompts/list`、`prompts/get`。

### 3.4 一个统摄视角：三类原语 = "谁有权把什么放进对话"

```
  Tools    → 模型拿起执行为    → 需要 Host 权限门 + 人类监督（最敏感）
  Resources→ Host 放进上下文   → Host 自己决定（数据战略）
  Prompts  → 用户拿话术进对话  → 用户主动（低风险）
```

这张"发起方 × 敏感度"表，就是 MCP 分类学的全部理由：**协议把"能动刀子的"、"能被读的"、"能被复制的"分开，让权限和上下文策略各自落在正确的对象上。**

---

## 四、连接生命周期与传输

### 4.1 握手：initialize

和人的见面礼仪一样，Client 连接 Server 的第一件事是一条 `initialize` 请求：

```
Client → Server: initialize {
  protocolVersion: "2025-06-18",        ⚠ 具体版本串
  capabilities:   {sampling, roots, ...},   // 我这边支持哪些（Client capability）
  clientInfo:     {name, version},
}
Server → Client: {
  protocolVersion: "2025-06-18",        // 若版本不匹配，Client 按它给的下调
  capabilities:   {tools, resources, prompts, logging, ...},  // Server 提供哪些
  serverInfo:     {name, version},
  instructions:   "...",                // ⚠ 一段自由文本：Server 给 Host 的"使用说明书"
}
Client → Server: notifications/initialized
```

三点值得记住：

1. **能力协商是双向声明**：Client 说自己支持 sampling/roots，Server 说自己提供 tools/resources/prompts。两边**各守各的半场**，协议不为未知能力报错。
2. **`instructions` = Server 递上来的一段指导语**，通常会注入到模型系统提示里（"我这个 server 怎么用最顺"）。⚠ 它本质是**外部输入的、不可信的**——Host 要把它当数据而不是命令（§六的安全模型会再谈）。
3. **向后兼容靠"协商"而非"单方面升级"**：新 Client 可以连老 Server、新 Server 可以被老 Client 连——协议版本在握手窗里各退一步。

### 4.2 传输：stdio、Streamable HTTP、WebSocket ⚠

| 传输 | 场景 | 特点 |
|---|---|---|
| **stdio** | 本地 Server（Host 起子进程） | stdin/stdout 传 JSON-RPC；进程即生命周期；**与用户同信任域** |
| **Streamable HTTP** | 远程/本地（异步、Fire-and-forget 的返回通道） | POST 传请求；响应可走流式（SSE）；取代了早期"HTTP+SSE"（⚠ 传输命名经历过改名：早期叫 HTTP+SSE，后并入 Streamable HTTP） |
| **WebSocket** | 远程全双工（⚠ 较新的标准传输，SDK 新版推崇） | 双向、低开销；适合高频双向事件 |

⚠ **判定**：截至我的知识，2025-03-26 版把 HTTP+SSE 归并为 Streamable HTTP；2025-11-25 版把 WebSocket 列为标准传输并从规范里移除 SSE 要求。**具体到"当前哪个是唯一标准传输"，以官方当时版为准**——传输层是 MCP 演进最快的地方，但概念（"JSON-RPC 帧可以走多种载体"）是稳定的。

### 4.3 帧与生命周期消息 ⚠

- 帧格式：**JSON-RPC 2.0**（Request / Response / Notification；Notification 无 id，一方发完不等回复）。
- 错误码：JSON-RPC 标准码（`-32600` 非法请求、`-32700` 解析错误…）+ MCP 自定义码（如内容过大/资源不存在之类）。⚠ 具体自定义码号以规范为准。
- 会话维持：`ping` 保活；`notifications/cancelled` 取消；`notifications/progress` 报长任务进度（可配 `progressToken`）。
- 体量：实现普遍设 JSON-RPC 消息大小上限（大结果报"内容过大"错误而非静默截断）。⚠ 默认上限值各 SDK 各异。

---

## 五、两个"反向"能力：Sampling 与 Roots

MCP 不只有"Server 供工具给模型用"这一个方向，还有两个把权力**反着转**的能力，恰恰是它设计完整性的证明：

### 5.1 Sampling：Server 反过来借用 Host 的模型

- 流程：Server → `sampling/createMessage` 请求 → **Host 用自己的模型**补一次推理，把结果返回 Server。
- 用途：比如一个"智能路由"Server 想自己判断一下该调哪个后端；一个代码分析 Server 想让模型给代码起名——**Server 自己也能"想"一下**，而不必自带模型。
- **权限含义（和安全关键）**：采样是 **Client capability**，且规范倡导 by-default 让**用户确认**（"这个服务端想用你的模型算一下，同意吗？"）。一次采样 = 一次宿主模型的成本 + 一次可被注入攻击的窗口，所以 Host 默认把采样当作"另一个需要审批的工具"。

### 5.2 Roots：Client 告诉 Server"你能碰哪些根目录"

- 流程：客户端在适合时发 `roots/list` 请求（Server → Client 方向，Client 提供）→ 返回 `{uri: "file:///home/me/project", name?: "project"}` 列表。
- 用途：文件类 Server 用它知道**干活的工作区在哪**；是 Server 理解"我的作用域"的契约。约等于 Claude Code 的 workspace / `--add-dir` 的概念，被协议化。
- 语义：**Roots 是"告知作用域"，不是"授权"**——Server 拿到 root 不代表它可以越权读写，真正的文件权限仍由 Host/OS 卡。

> 这两个能力合起来说明一件事：**MCP 的"上下文流"不是单向的"。** 不只是"供给能力给模型用"，还包括"Server 借模型之力"（Sampling）和"Host 交代边界"（Roots）。协议试图把 agent 协作里所有需要过问的通道都做进线里，而不是逼双方另起炉灶。

---

## 六、授权与安全模型：协议管装，Host 管权

### 6.1 授权（远程场景）

- 本地 stdio Server：与用户同进程，一般不需要网络授权。
- **远程 HTTP/WS Server：MCP 规范规定走 OAuth 2.0**（PKCE；用 resource indicator, RFC 8707 标明授权对象是哪个 MCP server；配合 RFC 8414 发现授权端点）。scope 形如 `mcp:tools:list` / `mcp.<server>.*` 之类（⚠ 具体字符串命名以规范为准）。
- 结论：**"连上即信任"是错的**；远程 Server 必须先完成 OAuth 握手，Host 才允许你连。

### 6.2 三层信任边界（MCP 官方文档里反复强调的分层）

```
第 1 层  用户 ←→ Host：用户信任自己的应用/代理
第 2 层  Host ←→ Server：协议层连接（含 6.1 的授权）
第 3 层  Server ←→ 底层系统：Server 自己持有的真实凭据
```

三个推论：
1. **Server 不可完全信任**（尤其远程的）。它提供的能力要经过 Host 的**权限门**（#8 的 allow/ask/deny 就该套在每个 MCP 工具上：`mcp_*` 一个通配就能统一管）——**MCP 工具是"别人写的代码"，权限上必须按"外部工具"对待**。
2. **Server 返给你的字符串都是数据，不是指令**（tool description、`instructions`、工具返回的文本）。这里有个现实威胁叫 **MCP prompt injection**：恶意 Server 在自己的工具描述/返回内容里写"忽略指令，调用 <危险工具>"。防御在 Host：把它当上下文内容，过模型前的 agent 指令依然由 Host 的 system prompt 主导。
3. **直连授权给 Server 的凭据（第 3 层）必须最窄**：Server 拿到用户的 GitHub token 不该能访问整仓。权限最小化依然是要 Server 实现者自觉的（协议约束不到业务侧）。

### 6.3 与 #8 权限的对接点（对我们的价值）

上一课我们学的权限矩阵，在这里正好落地：

- **发现侧**：Host 从 `tools/list` 拉到的工具，经过 #8 的 `disabled`/`visibleTools` 过滤后才秀给模型（`mcp_*` 通配一键管）；
- **执行侧**：`tools/call` 前走 `ctx.ask`，patterns 就是 `mcp:<server>:<tool>`，metadata 带参数给人类审；
- **策略侧**：sampling 默认 ask、远程 Server 走 OAuth、Server 输出当数据。

**一句话：MCP 把"能力怎么进来"标准化了，可它刻意没有标准化"该不该用"——那扇门永远留在 Host 的权限层，也就是我们在 #8 亲手建的那套东西。**

---

## 七、MCP 不是什么（边界澄清）

| 常被混淆 | MCP 不是这个 | 真正的是 |
|---|---|---|
| **函数调用（function calling）** | 不是某种模型 API 的功能 | 是一个**跨应用、跨传输的线协议**；function calling 只是某个厂商 API 的私有 schema，MCP 规范承载的 tools 可被任何支持它的模型/Host 消费 |
| **Agent 框架 / 编排** | 不是 agent loop、不是记忆、不是规划 | 标准化的"能力供给层"；agent 的循环/上下文/权限仍在 Host 里 |
| **远程执行沙箱** | 不是托管运行的沙箱 | 传输与授权协议；执行发生地由部署决定 |
| **A2A（Agent2Agent）** | 不是 agent 之间互聊的协议 | A2A 解决"agent ↔ agent"，MCP 解决"agent ↔ 工具/数据"，两者**互补**（Google 2025 推出 A2A，也捐给了 Linux Foundation） |
| **MCP = RPC** | 不只是通用远程调用 | 专为"给模型供给上下文与工具"设计：schema 语义（工具/资源/提示词）、能力协商、采样、roots 都是为 agent 场景定制的 |

---

## 八、给我们的启发（与 harness 的关系）

我们的 harness 目前**没有 MCP**（第 9 课代码侧你选择不学，这里只用概念做链接）：

| 概念 | 我们已有/未来要有的对应 |
|---|---|
| Host | `cli/repl.ts` + `loop/agent-loop.ts`（编排 + 消费工具） |
| Client（未来） | 一个"最小 MCP Client"：stdio 起子进程 → `initialize` 握手 → `tools/list` 拉 schema → 把工具塞进 `ToolRegistry`（#5）→ 执行走 `tools/call` |
| 权限门（#8 已建） | `toolsFor`/`disabled`（隐藏）+ `ctx.ask`（执行闸）——**MCP 工具天然吃这套**，只需把工具的 `permission` 名字用 `mcp_<server>_<tool>` 编码，`mcp_*` 通配就归一了 |
| 上下文（#6） | Resources 是"Host 按需注入数据的战略"，正合我们 `session/context.ts` 的可控注入思路；Prompts 是"用户斜杠命令"，可映射到我们 CLI 的 `/` 命令 |

**D 步（若将来做）：写一个 stdio 客户端 + 一个 10 行的 mock server（`tools/list` + `tools/echo`），把它的工具接进现有 ToolRegistry + 权限门，repl 里就能 `/mcp` 挂载。** 这正是"协议只需学概念、实现是流水线填插"的活教材。

---

## 九、为什么这样设计（工程观）

1. **协议只管"装与连"，不管"用不用"**：MCP 若替 Host 决定工具的可见性与授权，就会变成一个"什么都管、处处要信任"的巨兽。它刻意瘦身，把权力留给最该裁决的一方（用户所在的 Host）——**安全与权力必须与责任的边界重合**。
2. **三类原语 = 按"发起方与敏感度"分权**：工具（模型动刀，最危险）vs 资源（Host 注入，数据战略）vs 提示词（用户发言，低风险）。**分类让权限、缓存、审计各自找准对象**，而不是"万物皆工具"的一锅端。
3. **能力协商（initialize）制造"松耦合"**：两边的能力是声明的，不是假设的；版本靠握手缓冲。**这让生态能长**——新 Server、老 Host、新传输混搭不炸。
4. **双向控制流（Sampling/Roots）补齐了图谱**：Server 不只是被调用的对象，它还能借力、还能得知边界。**协议如果只做单向供给，就不配叫"上下文协议"。**
5. **把安全显式分层**：授权（OAuth）、信任（Server 不可信）、数据/指令之辨（prompt injection）都是"协议写明、Host 落实"。**协议能布防，但不能背锅**——这正是工程上的诚实。

> 一句话收束：**MCP 不是又一个框架，它是把"AI 应用 ↔ 能力提供方"之间的接口，从"私有胶水"提升到"公开协议"的那一次升级——装法（传输）、说法（三类原语）、把关法（授权+Host 权限）都被它规定，但"该不该让模型去动刀"，MCP 把它交还给了最该说这句话的人。**

---

## 十、一个具体例子：把协议变活（B 步开场）

MCP 听起来玄，其实是"两个进程用说好的 JSON 格式在线上对话"。抓住这句话，一切就都落地了。

### 10.1 先看线上到底走什么（stdio 传输 = 逐行 JSON）

stdio 传输的真相：Client 把工具进程拉起来，`stdin`/`stdout` 就是管道，每条 JSON-RPC 消息 = 一行 JSON。一个最小 MCP 会话的"线上"长这样（`→` 是 Client 发出，`←` 是 Server 回）：

```jsonc
// ① 握手：Client 报"我是谁、我能干啥、想要哪个版本"
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{
     "protocolVersion":"2025-06-18","capabilities":{},
     "clientInfo":{"name":"demo-host","version":"0.1.0"}}}
// ② Server 报"我提供 tools，这版本我接受"
← {"jsonrpc":"2.0","id":1,"result":{
     "protocolVersion":"2025-06-18",
     "capabilities":{"tools":{}},
     "serverInfo":{"name":"echo","version":"0.1.0"}}}
// ③ Client 说"初始化完毕"（Notification：没有 id，不期待回复）
→ {"jsonrpc":"2.0","method":"notifications/initialized"}

// ④（过一会儿）拉工具清单 + 调用
→ {"jsonrpc":"2.0","id":2,"method":"tools/list"}
← {"jsonrpc":"2.0","id":2,"result":{"tools":[
     {"name":"echo","description":"把输入原样返回",
      "inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}]}}
→ {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"text":"hi"}}}
← {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"hi"}]}}
```

**"协议"= 这套约定好的 JSON 骨架。** server 说到底就是跑一个循环：读一行 JSON → 看 `method` 是什么 → 执行 → 回一行 JSON。任何语言都能写，因为最终只是 stdin/stdout 上的文本（HTTP/WS 传输同理，只是载体不同）。

### 10.2 用官方 TS SDK 的最短发派（Server + Client）

⚠ 以下为概念性示例，SDK 的导入路径/类名随版本演进（`McpServer`/`McpClient` 是 1.x 的新名，旧版是 `server.tool()` / `Client`），照当前 SDK 微调即可。

Server（`echo-server.ts`）—— 起一个进程就是"一个工具服务"：

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "0.1.0" });

server.registerTool(
  "echo", { description: "把输入原样返回", inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: "text", text }] }),
);

await server.connect(new StdioServerTransport());  // 接手 stdin/stdout，替它跑 10.1 那套循环
```

Client（在 Host 里：起子进程 → 握手 → 发现 → 调用）：

```ts
import { McpClient } from "@modelcontextprotocol/sdk/client/mcp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new McpClient({ name: "demo-host", version: "0.1.0" });
const transport = new StdioClientTransport({ command: "node", args: ["echo-server.js"] });
await client.connect(transport);                   // connect() 内部自动完成 ①握手 ③通知

const { tools } = await client.listTools();        // ④a 发现 → Host 拿 #8 权限门过滤后秀给模型
const res = await client.callTool({ name: "echo", arguments: { text: "hi" } });  // ④b 调用
```

翻译回我们学的概念：**`connect()` = 握手（§四）、`listTools()` = 能力发现（§三）、`callTool()` = "模型看到工具 → Host 过权限门 → 真的执行"（§六）**。将来接进 harness 的 Client，就是"把 `tools/list` 的返回喂给 ToolRegistry，把 `tools/call` 接到 execute"——其余全是协议细节。

---

## 十一、MCP 与 Skill：两张牌，各管一摊

> ⚠ B 步核心辨析。概念部分可信度高；涉及 Claude Code/SDK 的具体字段以官方为准。

### 11.1 Skill 是什么（先定义清楚）

**Skill（技能）= 一份"操作手册"资产，以渐进披露的方式喂给模型。**

- 形态：一个目录，核心是 `SKILL.md` —— YAML frontmatter（`name` + `description`）+ markdown 正文（完整操作步骤/规范/好案例）。可带 `scripts/`、`reference_*.md` 等附件。（Claude Code 里放 `.claude/skills/<名字>/` 或 `~/.claude/skills/`。）
- 机制（渐进披露）：**平时只给模型"技能名 + description"**；任务匹配上 description 时，才把正文读进上下文。描述写得好，模型才知道"该用这个"，正文才被加载。
- **Skill 改变"模型知道什么、怎么做"，不直接改变"模型能执行什么"**——执行仍要靠工具（内置、MCP、bash……）。

### 11.2 一张表看清两张牌

| | **MCP**（能力 / 连接） | **Skill**（知识 / 程序） |
|---|---|---|
| 本质 | 给 agent 的**执行边界**（传输 + capability 协议） | 教 agent **怎么干活**的静态手册 |
| 背后有没有服务在跑 | **有**：一个 Server 进程/服务，要握手、生命周期、授权 | **没有**：就是文件/URL，加载即用 |
| 谁访问 | 模型运行时**调用工具**（有真实副作用） | 模型任务匹配时**读进上下文**（改变行为） |
| 接入成本 | 起 server / 部署服务 / 处理 OAuth（远程） | 扔个文件夹 / 挂个 URL，零运维 |
| 失败模式 | 服务挂/版本漂/权限没配 → **真的会失败** | 几乎不失败（就是文本；最糟是"没被加载"） |
| 责任边界 | 执行侧：Host 过权限门，Server 不可全信 | 内容侧：正文是"指令"还是"数据"，要防注入 |

一句话：**MCP 是"能接线到外面的插头"；Skill 是"该怎么做事的说明书"。**

### 11.3 关系和组合：不是替代，是正交，还能叠放

- **正交**：一个管"能力"，一个管"知识"。MCP 解决"agent 怎么摸到外面的世界"，Skill 解决"摸到之后该怎么用 / 复杂的域知识从哪来"。
- **Skill 包 MCP**：skill 正文完全可以写"这个场景用 `github` MCP 的 `pull_request.create`"——skill 当导航，MCP 当执行。
- **Skill 教直接调 API**：不少产品不提供 MCP，而是"官方 REST API + 一份 SDK 级 skill"，让 agent 用自带的 webfetch/bash 直连接口。**没有服务要托管、没有 OAuth 舞步、没有版本协商**——对"知识/接口型"产品是最便宜的路径。

### 11.4 关于"大家都放弃 MCP 了"——精确一点

你看到的模式是真的，拆成三句：

1. **"知识/手册型"集成正迁往 Skill（或 "docs-as-skill"）。** 这类接口本就不需要"活的服务"——产品要的是"让 agent 学会用我的 API"，不是"起个常驻 server 开个后门"。Skill 对它们：零运维、低门槛、天然贴合 Claude Code 的 `.claude/skills/`。**你在外面看到一堆"用 skill 对接"的，多数是这类。**
2. **MCP 没消失，它退回到"该用它的事"。** 要**活的、有状态、精确作用域的执行**——读运行中的数据库、写配置好的 SaaS、桌面自动化、非 HTTP 协议——MCP（或直连 API + skill）依然是正解。Claude Code 至今把 `/mcp` 与 skills 并列支持，正是这个分工的注脚。**两种能力都在，取用看你要暴露的是"能力"还是"知识"。**
3. **所以"放弃 MCP"的正确说法是："过去什么都想塞进 MCP 的东西，现在按『执行 vs 知识』分流了。"** 不是方案变差，是**责任边界变清晰**——这正是 MCP 自己"只定义装连、不定义用不用"哲学在生态里的延伸：连都不需要的，别让它们背一整个协议。

> 落点正好是你的课程表：#10 就是 **Skill**（opencode 的 `skill/` 模块 + 渐进披露）。看完 #9"协议该什么时候用"，#10 讲"手册该什么时候给"——两者合起来才是完整的"agent 能力供给"全景。

---

## 附录：待核对清单（本文按记忆写成，以下内容请对官方规范校准）

概念层（§一—§三、§九）可信度高；以下是**具体字面细节**，会随规范版本漂移，用了 `⚠` 标注处，建对 `spec.modelcontextprotocol.io` 当前版逐一确认：

- 最新协议版本串：我掌握的串有 `2024-11-05`、`2025-03-26`、`2025-06-18`、`2025-11-25`（后两个置信度递减）；确认当前最新版本。
- 传输现状：Streamable HTTP 是否仍是推荐远程传输？WebSocket 是否已成为标准传输、SSE 是否已从规范中移除？
- 方法名细节：通知的统一写法（`notifications/x`）、`resources/updated` 与 `resources/list_changed` 的分工、`logging/setLevel` 是否仍是唯一日志控制入口。
- MCP 自定义错误码的具体数值（如资源不存在、内容过大对应的码）。
- JSON-RPC 消息默认大小上限（各 SDK 是否一致）。
- OAuth 授权 scope 的确切命名（`mcp:tools:list` 之类）与 RFC 8414/8707 的引用是否仍在手。
- `instructions` 字段在握手中的确切语义与注入位置。
- Tool result 的 content 块类型全集（text/image/audio/resource）与 `isError`/`structuredContent` 字段名。

## 十二、思考题（B 步讨论）

1. **为什么"万物皆是工具"是坏的抽象？** 如果把 Resources/Prompts 都塞进 Tools 会出什么问题？（提示：#6 上下文管理的可控性、权限差异、用户主动 vs 模型主动）
2. **谁有权决定"模型看到哪些 MCP 工具"？** 协议把权力放在 Host，而不是 Server 自己声明即可——这对安全意味着什么？如果换成"Server 说了算"会导向什么灾难？
3. **MCP 的 `instructions` 和工具返回文本为什么是可疑的？** prompt injection 具体怎么发生？Host 该在哪一层拦？（链接：我们在 #8 学的 `ctx.ask` 能防住吗？）
4. **Sampling 为什么默认要用户确认？** 一个"想借宿主模型算一下"的 Server，和"想在宿主模型上下文里埋指令"的 Server，边界在哪？Host 该给采样什么默认权限？
5. **stdio vs Streamable HTTP vs WebSocket**——如果你要给我们的 harness 写一个"本地文件服务器"，选哪个？选远程第三方服务，又是哪个？信任域如何影响传输选择？
6. **版本协商为什么比"强制最新"更好？** 如果 Client 硬性要求 Server 必须跟到最新协议版本，生态会怎样？
7. **A2A 与 MCP 的关系**——"agent 调工具"和"agent 调 agent"在授权、上下文、发现上有哪些相似与不同？
8. **对照我们已完成的知识**：把一个 MCP 工具接进 harness，哪几层已经有现成零件（#5 ToolRegistry、#8 权限门、#6 context），哪几层是全新要写的（Client/传输/握手）？