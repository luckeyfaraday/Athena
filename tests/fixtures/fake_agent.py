from __future__ import annotations

import argparse
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-last-message", required=True)
    parser.add_argument("--exit-code", type=int, default=0)
    parser.add_argument("--stderr", default="")
    args = parser.parse_args()

    prompt = sys.stdin.read()
    result_path = Path(args.output_last_message)
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(f"fake final message\nprompt-bytes={len(prompt)}\n", encoding="utf-8")

    print("fake stdout")
    if args.stderr:
        print(args.stderr, file=sys.stderr)
    return args.exit_code


if __name__ == "__main__":
    raise SystemExit(main())

