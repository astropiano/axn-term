#!/usr/bin/env python3
"""todo — a tiny JSON-file todo CLI for demos."""

import argparse
import json
import sys
from pathlib import Path

STORE = Path(__file__).with_name("todos.json")


def load() -> list[dict]:
    if STORE.exists():
        return json.loads(STORE.read_text())
    return []


def save(todos: list[dict]) -> None:
    STORE.write_text(json.dumps(todos, indent=2) + "\n")


def main() -> int:
    p = argparse.ArgumentParser(prog="todo")
    sub = p.add_subparsers(dest="cmd", required=True)
    add = sub.add_parser("add")
    add.add_argument("text")
    sub.add_parser("list")
    done = sub.add_parser("done")
    done.add_argument("id", type=int)
    args = p.parse_args()

    todos = load()
    if args.cmd == "add":
        todos.append({"id": len(todos) + 1, "text": args.text, "done": False})
        save(todos)
    elif args.cmd == "done":
        for t in todos:
            if t["id"] == args.id:
                t["done"] = True
        save(todos)
    for t in todos:
        mark = "x" if t["done"] else " "
        print(f"[{mark}] {t['id']}. {t['text']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
