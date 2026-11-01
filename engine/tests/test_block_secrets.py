"""KV cache: none

The repo's PreToolUse secret guard (.claude/hooks/block_secrets.py): what it blocks and what it lets through.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

HOOK = Path(__file__).resolve().parents[2] / ".claude" / "hooks" / "block_secrets.py"


def run_hook(tool: str, tool_input: dict) -> int:
    proc = subprocess.run(
        [sys.executable, "-I", str(HOOK)],
        input=json.dumps({"tool_name": tool, "tool_input": tool_input}),
        capture_output=True,
        text=True,
        timeout=30,
    )
    return proc.returncode


@pytest.mark.parametrize(
    "command",
    [
        "echo $OPENAI_API_KEY",
        "echo ${ANTHROPIC_API_KEY}",
        "curl -H \"x: $DEEPSEEK_API_KEY\" http://127.0.0.1",
        "echo $GEMINI_API_KEY $GOOGLE_API_KEY",
        "Write-Output $env:ANTHROPIC_API_KEY",
        "echo $OPENAI_CUSTOM_HEADERS",
        "echo $NEO4J_AUTH $WANDB_API_KEY $ODDS_API_KEY2",
        "cat ~/.rlm-harness/keys.json",
    ],
)
def test_blocks_provider_credentials(command: str) -> None:
    assert run_hook("Bash", {"command": command}) == 2


def test_blocks_reading_the_fallback_key_file() -> None:
    assert run_hook("Read", {"file_path": "C:/Users/me/.rlm-harness/keys.json"}) == 2


@pytest.mark.parametrize(
    "command",
    [
        "echo $HOME $PATH",
        "echo $MONKEY",
        "cat ~/.rlm-harness/key-index.json",
        "git status",
    ],
)
def test_allows_ordinary_commands(command: str) -> None:
    assert run_hook("Bash", {"command": command}) == 0


def test_allows_reading_the_key_index() -> None:
    assert run_hook("Read", {"file_path": "C:/Users/me/.rlm-harness/key-index.json"}) == 0
