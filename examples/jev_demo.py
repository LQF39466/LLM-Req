#!/usr/bin/env python3
"""Run an OpenCode Jev decision using only the Python standard library.

Run: python3 examples/jev_demo.py
Uses OPENCODE_API_KEY from the environment or this project's .env file.
The jev-1.13 model is billed per request.
"""

import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request


def api_key():
    if os.environ.get("OPENCODE_API_KEY"):
        return os.environ["OPENCODE_API_KEY"]
    env_file = Path(__file__).resolve().parent.parent / ".env"
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            name, separator, value = line.strip().partition("=")
            if separator and name.strip() == "OPENCODE_API_KEY":
                return value.strip().strip("\"'")
    sys.exit("Set OPENCODE_API_KEY or add it to the LLM-Req .env file.")


def main():
    payload = {
        "model": "jev-1.13",
        "state": "My payments have failed for three days and I am losing sales. Please help now.",
        "questions": {
            "is_urgent": {
                "type": "noul",
                "instructions": "Does this request require urgent attention?",
            }
        },
    }
    request = urllib.request.Request(
        "https://opencode.ai/inference/systemone/v1/systemone",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key()}", "Content-Type": "application/json", "User-Agent": "node"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
    except urllib.error.HTTPError as exc:
        sys.exit(f"HTTP {exc.code}: {exc.read().decode('utf-8', errors='replace')}")
    except (urllib.error.URLError, TimeoutError) as exc:
        sys.exit(f"Request failed: {exc}")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
