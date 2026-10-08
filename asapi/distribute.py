#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
扫描指定文件夹下所有 .js 文件，将 AsAPI 的 @early inject / @inject
标记区块替换为脚本目录下 AsAPI.js 中的对应区块，并保留原文件缩进。
"""

import argparse
import re
import shutil
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ASAPI_FILE = SCRIPT_DIR / "AsAPI.js"

MARKERS = [
    ("@early inject", "/* AsAPI: Start @early inject */", "/* AsAPI: End @early inject */"),
    ("@inject",       "/* AsAPI: Start @inject */",       "/* AsAPI: End @inject */"),
]


def build_pattern(start_marker: str, end_marker: str) -> re.Pattern:
    return re.compile(
        re.escape(start_marker) + r".*?" + re.escape(end_marker),
        re.DOTALL,
    )


def extract_blocks(asapi_content: str) -> dict:
    blocks = {}
    for name, start, end in MARKERS:
        pattern = build_pattern(start, end)
        match = pattern.search(asapi_content)
        if not match:
            raise ValueError(f"AsAPI.js 中未找到标记区块: {name}")
        blocks[name] = match.group(0)
    return blocks


def apply_indent(block: str, indent: str) -> str:
    """block 首行保持原样，其余每行前加上 indent。"""
    if not indent:
        return block
    lines = block.split("\n")
    if len(lines) == 1:
        return lines[0]
    return lines[0] + "\n" + "\n".join(indent + line for line in lines[1:])


def sub_with_indent(content: str, pattern: re.Pattern, block: str) -> tuple[str, int]:
    """替换所有匹配，每处按该处所在行的缩进对齐 block。"""
    result = []
    pos = 0
    count = 0

    for match in pattern.finditer(content):
        result.append(content[pos:match.start()])

        line_start = content.rfind("\n", 0, match.start()) + 1
        prefix = content[line_start:match.start()]
        indent = prefix if prefix.strip() == "" else ""

        result.append(apply_indent(block, indent))
        pos = match.end()
        count += 1

    result.append(content[pos:])
    return "".join(result), count


def replace_in_file(js_path: Path, blocks: dict) -> int:
    try:
        content = js_path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        content = js_path.read_text(encoding="latin-1")

    original = content
    total = 0

    for name, start, end in MARKERS:
        pattern = build_pattern(start, end)
        content, count = sub_with_indent(content, pattern, blocks[name])
        total += count

    if content != original:
        js_path.write_text(content, encoding="utf-8")
    return total


def main():
    parser = argparse.ArgumentParser(description="替换 JS 文件中的 AsAPI 注入区块（保留缩进）")
    parser.add_argument("folder", help="要扫描的文件夹路径")
    parser.add_argument("--dry-run", action="store_true", help="只显示将要修改的文件，不实际写入")
    parser.add_argument("--backup", action="store_true", help="修改前生成 .bak 备份")
    args = parser.parse_args()

    target_dir = Path(args.folder).resolve()
    if not target_dir.is_dir():
        print(f"错误：目录不存在 -> {target_dir}", file=sys.stderr)
        sys.exit(1)

    if not ASAPI_FILE.is_file():
        print(f"错误：未找到 AsAPI.js -> {ASAPI_FILE}", file=sys.stderr)
        sys.exit(1)

    asapi_content = ASAPI_FILE.read_text(encoding="utf-8")
    try:
        blocks = extract_blocks(asapi_content)
    except ValueError as e:
        print(f"错误：{e}", file=sys.stderr)
        sys.exit(1)

    js_files = sorted(target_dir.rglob("*.js"))
    print(f"扫描目录: {target_dir}")
    print(f"找到 {len(js_files)} 个 .js 文件\n")

    changed_files = 0
    total_replacements = 0

    for js_file in js_files:
        if js_file.resolve() == ASAPI_FILE:
            continue

        count = 0
        if args.dry_run:
            try:
                content = js_file.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                content = js_file.read_text(encoding="latin-1")
            for name, start, end in MARKERS:
                pattern = build_pattern(start, end)
                count += len(pattern.findall(content))
        else:
            if args.backup:
                shutil.copy2(js_file, js_file.with_suffix(js_file.suffix + ".bak"))
            count = replace_in_file(js_file, blocks)

        if count > 0:
            changed_files += 1
            total_replacements += count
            prefix = "[DRY-RUN] " if args.dry_run else ""
            print(f"{prefix}已{'将' if args.dry_run else ''}替换 {count} 处: {js_file}")

    print("\n完成。")
    print(f"受影响文件: {changed_files}")
    print(f"总替换次数: {total_replacements}")


if __name__ == "__main__":
    main()