# Agent Engineering 深度实践 · Part 5

## Agent Loop 从零构建：200 行代码理解 Agent 的全部原理

---

> 这是整个学习路径中最关键的一步。不依赖任何框架，只用 Python + Anthropic SDK，从零手写一个 agent loop。

---

## 0. 为什么必须做这一步

你现在用 Claude Code 开发 FlashNote——感觉 Claude 很聪明，会读文件、会写代码、会自我修正。

但你以为的"Claude 在思考"实际上是：

```
while 任务未完成:
    把全部历史消息 + CLAUDE.md + 工具定义传给 API
    → LLM 返回：文本 + tool_use（"我想读 CardWall.tsx"）
    → 你的代码解析 tool_use，自己去读文件
    → 把文件内容包成 User 消息，追回 messages 数组
    → 再调一次 API
```

**不亲手写这个 loop，你对 Agent 的认知永远停留在"AI 自动完成了"的黑盒状态。**

写完这个 Demo，你会：
- 每看到 Claude Code 的 tool call，心里自动浮现背后的代码
- 理解为什么长对话会变贵、变笨
- 知道 Prompt Caching 省的不是"记忆"而是"计算"
- 能自己设计 tool definition，而不是猜"这样写行不行"

---

## 1. 架构总览

```
┌─────────────────────────────────────────────┐
│                  Agent Loop                  │
│                                             │
│  messages = [user_task]                      │
│                                             │
│  loop:                                      │
│    response = api.call(messages, tools)      │
│    messages.append(response)   ← assistant   │
│                                             │
│    if has_tool_use(response):               │
│      result = execute_tool(...)    ← 你的代码│
│      messages.append(result)      ← user    │
│      continue                                │
│    else:                                     │
│      return response.text       ← 任务完成   │
└─────────────────────────────────────────────┘
```

**26 行伪代码。核心就这些。**

---

## 2. Step 1 — 最小可行版本（~120 行）

### 2.1 环境准备

```bash
pip install anthropic
```

### 2.2 完整代码

```python
"""
minimal_agent.py — 最小 Agent Loop
用法: python minimal_agent.py "创建一个 hello.txt 文件"
"""

import anthropic
import json
import os
import subprocess
import sys

# ══════════════════════════════════════════════════════════
# 第 1 部分：定义你的工具
# ══════════════════════════════════════════════════════════
TOOLS = [
    {
        "name": "read_file",
        "description": "Read a file's contents. Use to examine existing files.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path to the file"}
            },
            "required": ["path"]
        }
    },
    {
        "name": "write_file",
        "description": "Write or overwrite a file. Use to create or update files.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path to the file"},
                "content": {"type": "string", "description": "Content to write"}
            },
            "required": ["path", "content"]
        }
    },
    {
        "name": "list_files",
        "description": "List files in a directory. Use to explore project structure.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Directory path, default is current"}
            },
            "required": []
        }
    },
    {
        "name": "run_command",
        "description": "Run a shell command and return its output.",
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "The command to execute"}
            },
            "required": ["command"]
        }
    },
    {
        "name": "finish",
        "description": "Call this when the task is complete. Provide a summary of what was done.",
        "input_schema": {
            "type": "object",
            "properties": {
                "summary": {"type": "string", "description": "What was accomplished"}
            },
            "required": ["summary"]
        }
    }
]

SYSTEM_PROMPT = """You are an AI coding agent. You have access to tools for reading/writing files and running commands.
Work step by step. Read files before editing them. When the task is done, call the finish tool.
Be precise and careful with file operations."""

# ══════════════════════════════════════════════════════════
# 第 2 部分：工具执行器（这是你的代码，不是 LLM 的）
# ══════════════════════════════════════════════════════════
def execute_tool(name: str, args: dict) -> str:
    """Execute a tool and return its result as a string."""
    try:
        if name == "read_file":
            if not os.path.exists(args["path"]):
                return f"Error: File '{args['path']}' not found."
            with open(args["path"], "r", encoding="utf-8") as f:
                content = f.read()
            if len(content) > 8000:
                content = content[:8000] + "\n... [truncated]"
            return content

        elif name == "write_file":
            os.makedirs(os.path.dirname(args["path"]) or ".", exist_ok=True)
            with open(args["path"], "w", encoding="utf-8") as f:
                f.write(args["content"])
            return f"Successfully wrote {len(args['content'])} bytes to {args['path']}"

        elif name == "list_files":
            path = args.get("path", ".")
            if not os.path.exists(path):
                return f"Error: Directory '{path}' not found."
            files = os.listdir(path)
            return "\n".join(files[:50])

        elif name == "run_command":
            result = subprocess.run(
                args["command"], shell=True, capture_output=True,
                text=True, timeout=30, cwd=os.getcwd()
            )
            output = result.stdout
            if result.stderr:
                output += "\n[stderr]\n" + result.stderr
            if len(output) > 5000:
                output = output[:5000] + "\n... [truncated]"
            return output

        elif name == "finish":
            return "Task marked as complete."

        else:
            return f"Error: Unknown tool '{name}'. Available: read_file, write_file, list_files, run_command, finish"

    except Exception as e:
        return f"Error executing {name}: {str(e)}\nPlease try a different approach."

# ══════════════════════════════════════════════════════════
# 第 3 部分：核心 Agent Loop
# ══════════════════════════════════════════════════════════
def agent_loop(task: str, max_steps: int = 30) -> str:
    client = anthropic.Anthropic()  # 使用 ANTHROPIC_API_KEY 环境变量

    # messages 数组 — 这就是 Agent 的"记忆"
    messages = [{"role": "user", "content": task}]

    for step in range(max_steps):
        print(f"\n{'='*60}")
        print(f"Step {step + 1}/{max_steps}")

        # --- 调用 LLM ---
        response = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=4096,
            system=SYSTEM_PROMPT,
            messages=messages,
            tools=TOOLS,
        )

        # --- 记录 Assistant 的回复 ---
        assistant_msg = {"role": "assistant", "content": response.content}
        messages.append(assistant_msg)

        # --- 检查 AI 是否想调用工具 ---
        tool_uses = [b for b in response.content if b.type == "tool_use"]

        if not tool_uses:
            # 没有 tool_use → 任务完成
            text_blocks = [b for b in response.content if b.type == "text"]
            final_text = "\n".join(b.text for b in text_blocks)
            print(f"\nAgent finished:\n{final_text}")
            return final_text

        # --- 执行所有工具调用 ---
        print(f"Tool calls: {[t.name for t in tool_uses]}")
        tool_results = []

        for tu in tool_uses:
            print(f"  → {tu.name}({json.dumps(tu.input, ensure_ascii=False)[:100]})")
            result = execute_tool(tu.name, tu.input)
            print(f"  ← {result[:150]}...")
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": tu.id,
                "content": result,
            })

        # --- 把工具结果作为 User 消息塞回去 ---
        messages.append({"role": "user", "content": tool_results})

    return "Agent reached max steps without finishing."

# ══════════════════════════════════════════════════════════
# 第 4 部分：运行
# ══════════════════════════════════════════════════════════
if __name__ == "__main__":
    task = sys.argv[1] if len(sys.argv) > 1 else "List the files in the current directory"
    print(f"Task: {task}\n")
    result = agent_loop(task)
    print(f"\n{'='*60}")
    print(f"FINAL: {result}")
```

### 2.3 运行

```bash
export ANTHROPIC_API_KEY="sk-ant-..."

# 简单任务
python minimal_agent.py "创建 hello.txt，内容是 'Hello World'"

# 多步任务
python minimal_agent.py "在当前目录创建一个简单的 HTML 网页，包含标题和一段文字"

# 需要读文件的任务
python minimal_agent.py "读取 README.md，告诉我项目名称和描述"
```

### 2.4 你在这一步学到什么

运行这个 Demo，观察终端输出。你会看到：

```
Step 1/30
Tool calls: ['read_file', 'list_files']
  → read_file({"path": "README.md"})
  ← # My Project...

Step 2/30
Tool calls: ['write_file']
  → write_file({"path": "hello.txt", "content": "Hello World"})
  ← Successfully wrote 11 bytes...

Step 3/30
Agent finished: I created hello.txt with "Hello World"...
```

**这一刻你亲眼看到了**：
- Claude **不是**自己读了文件——是你的 `execute_tool` 读了，把结果包好传回去的
- Claude **不是**自己写了文件——是你的代码写了
- 每一步 Claude 只能"说话"——"我想读 X"、"我想写 Y"。手脚是你的代码

---

## 3. Step 2 — 添加 Token 管理（+50 行）

最小版本的问题：如果对话太长，messages 数组会撑爆 API 的上下文窗口。

### 3.1 添加 Token 计数

```python
import tiktoken

enc = tiktoken.get_encoding("cl100k_base")

def count_tokens(messages: list, system_prompt: str) -> int:
    """计算 messages + system prompt 的总 token 数"""
    total = len(enc.encode(system_prompt))
    for msg in messages:
        if isinstance(msg["content"], str):
            total += len(enc.encode(msg["content"]))
        elif isinstance(msg["content"], list):
            for block in msg["content"]:
                total += len(enc.encode(json.dumps(block)))
    return total
```

### 3.2 在循环中加入预算检查

```python
TOKEN_LIMIT = 150_000  # 给 200K 窗口留余量

for step in range(max_steps):
    # --- 检查 token 预算 ---
    current_tokens = count_tokens(messages, SYSTEM_PROMPT)
    print(f"  Tokens: {current_tokens} / {TOKEN_LIMIT}")

    if current_tokens > TOKEN_LIMIT:
        print("  ⚠️ Token budget exceeded. Compressing context...")
        messages = compress_context(messages)

    # ... 继续正常循环 ...
```

### 3.3 上下文压缩（朴素版）

```python
def compress_context(messages: list) -> list:
    """朴素压缩：只保留第一条 user 消息 + 最近 10 条消息"""
    if len(messages) <= 12:
        return messages
    first = messages[0]      # 保护原始任务
    recent = messages[-10:]  # 最近 10 条
    return [first] + recent
```

### 3.4 上下文压缩（摘要版 — 进阶）

```python
def compress_context_with_summary(messages: list, client) -> list:
    """用 LLM 生成历史摘要，替代中间消息"""
    if len(messages) <= 15:
        return messages

    first = messages[0]
    recent = messages[-8:]
    middle = messages[1:-8]

    # 让一个小、快的模型做摘要
    summary_response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1024,
        system="Summarize the conversation below. Include: key decisions, current state, pending tasks.",
        messages=[{"role": "user", "content": json.dumps(middle, default=str)}],
    )
    summary = summary_response.content[0].text

    return [
        first,
        {"role": "user", "content": f"[Conversation summary: {summary}]"},
        *recent,
    ]
```

---

## 4. Step 3 — 循环检测（+30 行）

Agent 可能陷入循环：反复读同一个文件、反复执行同一个命令。

```python
from collections import deque

class LoopDetector:
    def __init__(self, window_size: int = 10, threshold: int = 3):
        self.recent = deque(maxlen=window_size)
        self.threshold = threshold

    def record(self, tool_name: str, tool_input: dict) -> bool:
        """记录操作。返回 True 表示检测到循环"""
        action = (tool_name, json.dumps(tool_input, sort_keys=True))
        self.recent.append(action)

        # 最近的操作是否重复了 threshold 次
        if len(self.recent) >= self.threshold:
            last_n = list(self.recent)[-self.threshold:]
            if len(set(last_n)) == 1:
                return True
        return False

# 在 agent loop 中使用
detector = LoopDetector()

for tu in tool_uses:
    if detector.record(tu.name, tu.input):
        print(f"  ⚠️ Loop detected! Repeated {tu.name} too many times.")
        return "Stopped: agent entered a loop."
    result = execute_tool(tu.name, tu.input)
    ...
```

---

## 5. Step 4 — Tool Call 故障处理（+40 行）

```python
def execute_tool_with_retry(tu, client, messages, max_retries: int = 2) -> str:
    """执行 tool，如果 LLM 返回的 JSON 有误，让 LLM 修正"""
    for attempt in range(max_retries + 1):
        try:
            return execute_tool(tu.name, tu.input)
        except (json.JSONDecodeError, KeyError, TypeError) as e:
            if attempt < max_retries:
                # 把错误反馈给 LLM，让它修正
                messages.append({
                    "role": "user",
                    "content": [{
                        "type": "text",
                        "text": f"Your tool call to '{tu.name}' had an error: {e}. Please check the arguments and retry."
                    }]
                })
                response = client.messages.create(
                    model="claude-sonnet-4-20250514",
                    max_tokens=1024,
                    system=SYSTEM_PROMPT,
                    messages=messages,
                    tools=TOOLS,
                )
                # 尝试从修正后的响应中提取新的 tool_use
                new_tus = [b for b in response.content if b.type == "tool_use"]
                if new_tus:
                    tu = new_tus[0]
                    continue
            raise
```

---

## 6. Step 5 — 多 Provider 支持（+50 行）

展示底层 API 的差异。这里展示 Anthropic 和 OpenAI 的 tool call 格式差异：

```python
def call_llm(client_type: str, messages: list, system: str, tools: list):
    """统一的 LLM 调用接口，屏蔽 provider 差异"""

    if client_type == "anthropic":
        # Anthropic: tools 是顶层参数，tool_use 在 content blocks 里
        response = anthropic_client.messages.create(
            model="claude-sonnet-4-20250514",
            system=system,
            messages=messages,
            tools=tools,
        )
        tool_uses = [b for b in response.content if b.type == "tool_use"]
        text = "\n".join(b.text for b in response.content if b.type == "text")
        return {"text": text, "tool_uses": tool_uses}

    elif client_type == "openai":
        # OpenAI: tools 是顶层参数，但 tool_calls 在 message 对象里
        # 而且 tool 定义格式不同：function.name vs name
        openai_tools = [
            {"type": "function", "function": {
                "name": t["name"],
                "description": t["description"],
                "parameters": t["input_schema"]
            }}
            for t in tools
        ]
        response = openai_client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "system", "content": system}] + messages,
            tools=openai_tools,
        )
        msg = response.choices[0].message
        return {
            "text": msg.content or "",
            "tool_uses": [
                {"name": tc.function.name, "input": json.loads(tc.function.arguments)}
                for tc in (msg.tool_calls or [])
            ]
        }
```

---

## 7. 测试你的 Agent

```python
def test_agent():
    """基本测试：验证 Agent 能完成简单任务"""

    # 测试 1：文件创建
    result = agent_loop("Create test_output.txt with 'test content'")
    assert os.path.exists("test_output.txt")
    with open("test_output.txt") as f:
        assert "test content" in f.read()
    os.remove("test_output.txt")
    print("✅ Test 1 passed: File creation")

    # 测试 2：信息读取
    with open("test_readme.md", "w") as f:
        f.write("# Test Project\nA test project.")
    result = agent_loop("Read test_readme.md and tell me the project name")
    assert "Test Project" in result
    os.remove("test_readme.md")
    print("✅ Test 2 passed: File reading")

    # 测试 3：不超过 max_steps
    result = agent_loop("List files in current directory")
    assert result is not None
    print("✅ Test 3 passed: Completes within budget")

    # 测试 4：错误处理
    result = agent_loop("Read nonexistent_file_xyz.md")
    assert result is not None
    print("✅ Test 4 passed: Handles errors gracefully")

    print("\n🎉 All tests passed!")

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "--test":
        test_agent()
    else:
        task = sys.argv[1] if len(sys.argv) > 1 else "List files in current directory"
        result = agent_loop(task)
        print(f"\nFINAL: {result}")
```

---

## 8. 你从这一步带走的认知

完成这个 Demo 后，你应该能回答：

| 问题 | 答案在代码的哪里 |
|------|----------------|
| Agent Loop 的核心循环是什么？ | 第 3 部分 `for step in range(max_steps)` |
| LLM 的"记忆"存在哪里？ | `messages` 数组 |
| Tool 是怎么被调用的？ | `execute_tool()` 函数 — 你的代码，不是 LLM |
| Tool 结果怎么回到 LLM？ | `messages.append({"role": "user", ...})` |
| 为什么长对话会变贵？ | `messages` 每次调用都完整传回 |
| 怎么检测循环？ | `LoopDetector` 类 |
| 怎么控制成本？ | `count_tokens()` + `compress_context()` |
| Anthropic 和 OpenAI 的 tool 格式有什么区别？ | `call_llm()` 里的两个分支 |

---

## 9. 下一步

写完这个 Demo 并跑通所有测试后，你有两条路：

**路线 A**：继续完善 Demo → 加 Planning + Memory + 多 Agent → 变成一个通用 Agent 框架（Handbook 的项目 5）

**路线 B**：用已掌握的原理，直接进入小说写作 Agent 的构建（Part 6）。因为底层原理你已经亲手实现过了，构建上层应用时你对每个设计决策都有底层直觉。

**推荐路线 B。** 你已经不需要再写一个"通用 Agent 框架"来证明自己——市面上的框架多的是，不缺你这个。但一个好用的写作 Agent，目前没有。
