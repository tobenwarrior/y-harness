#!/usr/bin/env python3
"""Run one minimal-agent turn through the bundled Python SDK runtime."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from yharness import YHarness


def main() -> None:
    """Parse one task and print the agent's final response."""
    parser = argparse.ArgumentParser()
    parser.add_argument("prompt", help="Task for the minimal agent")
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    parser.add_argument(
        "--yh-home",
        type=Path,
        help="Explicit Y Harness home (or use YH_HOME)",
    )
    parser.add_argument(
        "--dsh-home",
        type=Path,
        help="Legacy alias for --yh-home (or use DSH_HOME)",
    )
    parser.add_argument("--profile", default="sdk-minimal")
    parser.add_argument("--session-id")
    parser.add_argument("--provider", default="deepseek-official")
    parser.add_argument("--model", default=os.environ.get("DSH_MODEL", "deepseek-v4-flash"))
    parser.add_argument("--max-tokens", type=int)
    args = parser.parse_args()
    if args.yh_home is not None and args.dsh_home is not None:
        parser.error("--yh-home and --dsh-home cannot be used together")
    config_kwargs: dict[str, str] = {}
    if args.yh_home is not None:
        config_kwargs["yh_home"] = str(args.yh_home.resolve())
    elif args.dsh_home is not None:
        config_kwargs["dsh_home"] = str(args.dsh_home.resolve())
    elif os.environ.get("YH_HOME", "").strip():
        config_kwargs["yh_home"] = os.environ["YH_HOME"]
    elif os.environ.get("DSH_HOME", "").strip():
        config_kwargs["dsh_home"] = os.environ["DSH_HOME"]
    else:
        parser.error("--yh-home/--dsh-home or a non-empty YH_HOME/DSH_HOME is required")

    workspace = args.workspace.resolve()
    with YHarness(
        provider=args.provider,
        model=args.model,
        max_tokens=args.max_tokens,
        cwd=str(workspace),
        profile=args.profile,
        **config_kwargs,
    ) as harness:
        result = harness.run(args.prompt, session_id=args.session_id)
    print(result.final_response)


if __name__ == "__main__":
    main()
