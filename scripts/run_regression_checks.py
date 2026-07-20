#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_REGRESSION_DIR = ROOT / "tests" / "regressions"
CLIENT_DIR = ROOT / "client"


def run_step(label: str, command: list[str], cwd: Path) -> int:
    print(f"\n==> {label}", flush=True)
    print(f"$ {' '.join(command)}", flush=True)
    return subprocess.run(command, cwd=cwd, check=False).returncode


def main() -> int:
    parser = argparse.ArgumentParser(description="Run permanent Athena regression checks.")
    parser.add_argument("--python-only", action="store_true")
    parser.add_argument("--client-only", action="store_true")
    args = parser.parse_args()
    if args.python_only and args.client_only:
        parser.error("--python-only and --client-only cannot be combined")

    failures = 0
    if not args.client_only:
        python_tests = sorted(BACKEND_REGRESSION_DIR.glob("test_*.py"))
        if not python_tests:
            print(f"Missing permanent backend regression tests under {BACKEND_REGRESSION_DIR}.")
            failures += 1
        else:
            failures += run_step(
                "Backend regression tests",
                [sys.executable, "-m", "pytest", str(BACKEND_REGRESSION_DIR)],
                ROOT,
            )
    if not args.python_only:
        failures += run_step("Client regression tests", ["npm", "run", "test:regression"], CLIENT_DIR)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
