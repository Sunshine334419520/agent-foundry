"""
minimal_agent.py — 最小 Agent Loop

用法:
    python minimal_agent.py "创建一个 hello.txt 文件"
    python minimal_agent.py --test          # 稍后实现
"""

import anthropic   # Anthropic 官方 SDK
import json        # 打印工具参数时序列化用
import os          # read_file / write_file / list_files 都用它
import subprocess  # run_command 用它跑 shell 命令
import sys         # 读取命令行参数 (sys.argv)
from collections import deque  # LoopDetector 用的滑动窗口

# ══════════════════════════════════════════════════════════
# 配置：直接从 ~/.claude/settings.json 读取（你的 DeepSeek 配置就在这）
#
# 你的 key / base_url 写在 Claude Code 的配置文件里，我们不再复制
# 到终端，而是让程序直接读它——一份配置，处处生效。
# 优先级：~/.claude/settings.json > 进程环境变量 > 代码默认值
# ══════════════════════════════════════════════════════════
def load_llm_config() -> dict:
    """读取 LLM 配置，返回 {base_url, auth_token, model}。"""
    env_from_file = {}
    config_path = os.path.expanduser("~/.claude/settings.json")
    if os.path.exists(config_path):
        try:
            with open(config_path, encoding="utf-8") as f:
                env_from_file = json.load(f).get("env", {})
        except (OSError, json.JSONDecodeError):
            pass  # 读不到就当没有，交给环境变量兜底

    def pick(key, default=None):
        """配置文件优先，其次进程环境变量，最后默认值。"""
        return env_from_file.get(key) or os.environ.get(key) or default

    return {
        "base_url":   pick("ANTHROPIC_BASE_URL"),
        "auth_token": pick("ANTHROPIC_AUTH_TOKEN"),
        # 注意：settings.json 里没有 ANTHROPIC_MODEL（那套 DEFAULT_* 是
        # Claude Code 内部路由用的）。所以默认值就是你实际用的模型，
        # 以后想换模型，改这一行。
        "model":      pick("ANTHROPIC_MODEL", "deepseek-v4-flash"),
    }

# 程序启动时读一次配置（不每次循环重读文件）
CFG = load_llm_config()

# ══════════════════════════════════════════════════════════
# 第 1 部分：定义工具（TOOLS = LLM 的"说明书"）
#
# 这段纯数据是发给 LLM 的"能力清单"。LLM 不会真的执行这些工具，
# 它只是知道"有这么些工具、各自接收什么参数"。
# 真正执行在后面的 execute_tool() —— 那是我们的代码。
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

# 系统提示词：给 LLM 立"人设"和"工作规矩"。
# 注意：这也是一段纯文本，LLM 的行为规则全在这里。
SYSTEM_PROMPT = """You are an AI coding agent. You have access to tools for reading/writing files and running commands.
Work step by step. Read files before editing them. When the task is done, call the finish tool.
Be precise and careful with file operations."""

# ══════════════════════════════════════════════════════════
# 第 2 部分：工具执行器（execute_tool）
#
# 整个 Agent 里唯一 100% 属于我们的代码。LLM 只是"说"它想
# 干什么（返回 tool_use 块），真正动手的全是这里的 if/elif 分支。
# ══════════════════════════════════════════════════════════
def execute_tool(name: str, args: dict) -> str:
    """执行一个工具调用。返回值永远是字符串——这是契约。"""
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
            path = args.get("path", ".")   # path 可选（TOOLS 里 required 是空），缺省看当前目录
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
            # 模型可能"幻觉"出不在清单里的工具名，给它一个自纠错的出口
            return f"Error: Unknown tool '{name}'. Available: read_file, write_file, list_files, run_command, finish"

    except Exception as e:
        # 核心设计：任何异常都不往上抛，而是转成字符串喂回给 LLM。
        # 让 LLM 看到错误、自己调整策略，而不是让整个 loop 崩溃。
        return f"Error executing {name}: {str(e)}\nPlease try a different approach."

# ══════════════════════════════════════════════════════════
# 第 2 步：Token 管理（"量 → 检查 → 剪"）
#
# 原理：记忆只增不减、每轮整包重发 → 成本二次方增长、窗口有上限、
# 注意力被噪音稀释。所以给记忆设一个预算，超了就"整理"。
# ══════════════════════════════════════════════════════════

# 记忆预算。注意：它不是窗口上限（那是 1M），而是"我们愿意为一次请求
# 付多少 token"、"上下文多长之后质量开始下降"的旋钮。
TOKEN_LIMIT = 200_000


def count_tokens(client, messages: list, system: str) -> int:
    """用官方 count_tokens 端点精确计量 memory（messages + system）的 token 数。

    实测过：DeepSeek 的 Anthropic 兼容端点支持这个接口。
    """
    resp = client.messages.count_tokens(
        model=CFG["model"],
        system=system,
        messages=messages,
    )
    return resp.input_tokens


def _is_tool_result_block(b) -> bool:
    """判断一个 content block 是不是 tool_result（兼容 dict 和 SDK 对象两种形态）。"""
    if isinstance(b, dict):
        return b.get("type") == "tool_result"
    return getattr(b, "type", None) == "tool_result"


def compress_context(messages: list, keep_recent: int = 10) -> list:
    """朴素压缩：保第一条任务 + 最近 keep_recent 条消息。

    地雷：不能把 assistant(tool_use) 和它对应的 user(tool_result) 切开，
    否则 API 会因配对断裂报错。所以切口如果落在"只含 tool_result 的
    user 消息"上，说明它的 tool_use 已经被丢了，这条也得一起丢。
    """
    if len(messages) <= keep_recent + 2:
        return messages
    first = messages[0]

    cut = len(messages) - keep_recent
    while cut < len(messages):
        m = messages[cut]
        content = m.get("content")
        if m.get("role") == "user" and not isinstance(content, str) and content:
            if all(_is_tool_result_block(b) for b in content):
                cut += 1   # 切口落在孤儿 tool_result 上，连同它一起丢
                continue
        break
    return [first] + messages[cut:]

# ══════════════════════════════════════════════════════════
# 第 3 步：循环检测（LoopDetector）
#
# Agent 可能陷入死循环：反复读同一个文件、反复跑同一条命令。
# 用"最近 N 次操作是否完全重复"来判断，是就熔断。
# ══════════════════════════════════════════════════════════
class LoopDetector:
    def __init__(self, window_size: int = 10, threshold: int = 3):
        self.recent = deque(maxlen=window_size)
        self.threshold = threshold

    def record(self, tool_name: str, tool_input: dict) -> bool:
        """记录一次操作。返回 True 表示检测到循环（应当熔断）。"""
        action = (tool_name, json.dumps(tool_input, sort_keys=True))
        self.recent.append(action)

        if len(self.recent) >= self.threshold:
            last_n = list(self.recent)[-self.threshold:]
            if len(set(last_n)) == 1:   # 最近 threshold 次完全相同 → 死循环
                return True
        return False

# ══════════════════════════════════════════════════════════
# 第 4 步：工具执行容错（execute_tool_with_retry）
#
# 诚实说明：我们的 execute_tool 已把绝大多数错误转成字符串喂回给
# 模型（error-as-data），模型会自己改。所以这里只是"双保险"——
# 万一 execute_tool 自己抛出结构性异常（比如我们代码有 bug），
# 重试几次；仍失败就返回错误字符串，让模型基于错误信息自我修正。
# ══════════════════════════════════════════════════════════
def execute_tool_with_retry(tu, max_retries: int = 2) -> str:
    """执行工具调用；结构性异常重试几次，最后仍失败则返回错误字符串。"""
    for attempt in range(max_retries + 1):
        try:
            return execute_tool(tu.name, tu.input)
        except (json.JSONDecodeError, KeyError, TypeError) as e:
            if attempt < max_retries:
                print(f"  ⚠️ Tool call error ({e}), retrying ({attempt + 1}/{max_retries})")
                continue
            return f"Error executing {tu.name}: {e}. Please try a different approach."

# ══════════════════════════════════════════════════════════
# 第 3 部分：核心 Agent Loop
#
# 全部零件在此组装。这个函数就是"Agent 的脑子"：
#   记忆 → 问一次 LLM → 它要不要动手？ → 动手 / 收尾 → 循环
# ══════════════════════════════════════════════════════════
def agent_loop(task: str, max_steps: int = 30) -> str:
    client = anthropic.Anthropic(
        base_url=CFG["base_url"],    # 从 Claude 配置文件读到的 DeepSeek 端点
        auth_token=CFG["auth_token"],  # 从 Claude 配置文件读到的 key
    )

    # ⭐ 这就是 Agent 的"记忆"——整个 Agent 的状态只有这一个列表
    messages = [{"role": "user", "content": task}]

    detector = LoopDetector()   # 循环检测器：连续重复操作就熔断

    for step in range(max_steps):   # 保险丝：绝不无限循环
        print(f"\n{'='*60}")
        print(f"Step {step + 1}/{max_steps}")

        # --- 0. 先量一量当前记忆有多大（Token 预算检查）---
        current_tokens = count_tokens(client, messages, SYSTEM_PROMPT)
        print(f"  [memory] {current_tokens:,} / {TOKEN_LIMIT:,} tokens")

        if current_tokens > TOKEN_LIMIT:
            print("  ⚠️ Token budget exceeded. Compressing context...")
            messages = compress_context(messages)
            new_tokens = count_tokens(client, messages, SYSTEM_PROMPT)
            print(f"  [memory after compress] {new_tokens:,} tokens")

        # --- 1. 问一次 LLM（那个 HTTP POST 的化身）---
        response = client.messages.create(
            model=CFG["model"],
            max_tokens=8192,
            system=SYSTEM_PROMPT,
            messages=messages,
            tools=TOOLS,
        )

        # --- 2. 把它的整个回复记进"记忆" ---
        # 注意 append 的是 response.content（整个内容块列表），不是只 append 文本。
        # tool_use 块、thinking 块都必须原样保留，下次请求才能"对得上号"。
        messages.append({"role": "assistant", "content": response.content})

        # --- 3. 看它想不想动手：回复里有没有 tool_use 块 ---
        tool_uses = [b for b in response.content if b.type == "tool_use"]

        if not tool_uses:
            # 没有 tool_use → 它选择用纯文本回答 → 任务完成
            text_blocks = [b for b in response.content if b.type == "text"]
            final_text = "\n".join(b.text for b in text_blocks)
            print(f"\nAgent finished:\n{final_text}")
            return final_text

        # --- 4. 它想动手：逐个执行（这一步是我们的代码在干活）---
        print(f"Tool calls: {[t.name for t in tool_uses]}")
        tool_results = []

        for tu in tool_uses:
            # 循环检测：同样的操作连续出现 threshold 次 → 熔断
            if detector.record(tu.name, tu.input):
                print("  ⚠️ Loop detected! Stopping agent.")
                return "Stopped: agent entered a loop."

            print(f"  → {tu.name}({json.dumps(tu.input, ensure_ascii=False)[:100]})")
            result = execute_tool_with_retry(tu)   # 容错版执行
            print(f"  ← {result[:150]}...")
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": tu.id,   # 必须精确对上它发的那个 id
                "content": result,
            })

        # --- 5. 把工具结果"假装成用户的话"塞回记忆，进入下一轮 ---
        # 所有结果打包在一条 user 消息里（拆成多条会让模型不敢再并行调用）
        messages.append({"role": "user", "content": tool_results})

    # 保险丝触发：30 步都没完成
    return "Agent reached max steps without finishing."

# ══════════════════════════════════════════════════════════
# 第 4 部分：运行入口
# ══════════════════════════════════════════════════════════
if __name__ == "__main__":
    task = sys.argv[1] if len(sys.argv) > 1 else "List the files in the current directory"
    print(f"Task: {task}\n")
    result = agent_loop(task)
    print(f"\n{'='*60}")
    print(f"FINAL: {result}")
