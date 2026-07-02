#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND_REGRESSION_DIR = ROOT / "tests" / "regressions"
CLIENT_DIR = ROOT / "client"


def has_python_regression_tests() -> bool:
    if not BACKEND_REGRESSION_DIR.exists():
        return False
    return any(
        path.name.startswith("test_") and path.suffix == ".py"
        for path in BACKEND_REGRESSION_DIR.rglob("*.py")
    )


def run_step(label: str, command: list[str], cwd: Path) -> int:
    print(f"\n==> {label}", flush=True)
    print(f"$ {' '.join(command)}", flush=True)
    return subprocess.run(command, cwd=cwd).returncode


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run the permanent regression checks that protect fixed bugs."
    )
    parser.add_argument(
        "--python-only",
        action="store_true",
        help="Run only backend/Python regression tests.",
    )
    parser.add_argument(
        "--client-only",
        action="store_true",
        help="Run only client/Electron regression tests.",
    )
    args = parser.parse_args()

    if args.python_only and args.client_only:
        parser.error("--python-only and --client-only cannot be used together")

    failures = 0

    if not args.client_only:
        if has_python_regression_tests():
            failures += run_step(
                "Backend regression tests",
                [sys.executable, "-m", "pytest", str(BACKEND_REGRESSION_DIR)],
                ROOT,
            )
        else:
            print("\n==> Backend regression tests")
            print(f"No Python regression tests found under {BACKEND_REGRESSION_DIR}.")

    if not args.python_only:
        failures += run_step(
            "Client regression tests",
            ["npm", "run", "test:regression"],
            CLIENT_DIR,
        )

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
