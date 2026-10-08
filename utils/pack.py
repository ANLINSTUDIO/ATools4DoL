#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
通用 Mod 打包脚本。

功能：
  1. 递归收集 img/ 下所有文件，更新 boot.json 的 imgFileList；
  2. 可选对 .js 用 terser 压缩、对 .css 做文本压缩（只写入 zip，不改源目录）；
  3. 将 Source/ 整体打包为 <ModName>-v<version>.mod.zip。

用法示例：
  python pack_mod.py
  python pack_mod.py -s ./Source -n SmartPhone
  python pack_mod.py -s ./Source -n SmartPhone -o ./dist --minify
  python pack_mod.py -s ./Source --img-dir img --no-update-boot --dry-run
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import zipfile
from pathlib import Path


# ----------------------------- 压缩相关 -----------------------------

def minify_js(file_path: Path) -> str | None:
    """用 terser 压缩 JS；terser 不可用或压缩失败返回 None，打包时退回原文件。"""
    exe = shutil.which("terser")
    if not exe:
        print("提示: 未找到 terser（npm install -g terser），JS 按原样打包")
        return None

    try:
        original = file_path.read_text(encoding="utf-8")
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as tf:
            tf.write(original)
            tmp = tf.name
        try:
            r = subprocess.run(
                [exe, tmp, "--compress", "--mangle", "--ecma", "2017"],
                capture_output=True, text=True, encoding="utf-8", timeout=120,
            )
            if r.returncode != 0 or not r.stdout.strip():
                print(f"警告: terser 压缩失败，按原样打包: {r.stderr.strip()[:200]}")
                return None
            print(f"已压缩: {file_path.name}  {len(original)} -> {len(r.stdout)} 字符")
            return r.stdout
        finally:
            os.unlink(tmp)
    except Exception as e:
        print(f"警告: 压缩出错，按原样打包: {e}")
        return None


def minify_css(file_path: Path) -> str | None:
    """压缩 CSS：去注释去空白（保护 url(...) 与引号串）；失败返回 None 退回原文件。"""
    try:
        original = file_path.read_text(encoding="utf-8")
        css = original

        tokens: list[str] = []

        def stash(m):
            tokens.append(m.group(0))
            return f"\x00{len(tokens) - 1}\x00"

        css = re.sub(r"url\([^)]*\)|\"[^\"]*\"|'[^']*'", stash, css)
        css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
        css = re.sub(r"\s+", " ", css)
        css = re.sub(r"\s*([{}:;,>~+])\s*", r"\1", css)
        css = re.sub(r";}", "}", css)
        css = css.strip()
        css = re.sub(r"\x00(\d+)\x00", lambda m: tokens[int(m.group(1))], css)

        print(f"已压缩: {file_path.name}  {len(original)} -> {len(css)} 字符")
        return css
    except Exception as e:
        print(f"警告: CSS 压缩出错，按原样打包: {e}")
        return None


# ----------------------------- 资源收集 -----------------------------

def collect_images(img_dir: Path, base_dir: Path) -> list[str]:
    """递归收集 img_dir 下所有文件相对 base_dir 的路径；目录不存在返回空。"""
    img_files: list[str] = []

    if not img_dir.exists():
        print(f"提示: {img_dir} 目录不存在，跳过")
        return img_files

    for file_path in img_dir.rglob("*"):
        if file_path.is_file():
            rel = str(file_path.relative_to(base_dir)).replace("\\", "/")
            img_files.append(rel)
            print(f"已添加图片: {rel}")

    img_files.sort()
    return img_files


def update_boot_json(boot_json_path: Path, img_files: list[str]) -> dict:
    """更新 boot.json 中的 imgFileList，返回读取到的 config。"""
    try:
        with open(boot_json_path, "r", encoding="utf-8") as f:
            config = json.load(f)

        config["imgFileList"] = img_files

        with open(boot_json_path, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=4, ensure_ascii=False)

        print(f"已更新 boot.json ({boot_json_path})，共 {len(img_files)} 个图片文件")
        return config
    except Exception as e:
        print(f"更新 boot.json 失败: {e}")
        raise


# ----------------------------- 打包 -----------------------------

def create_zip(zip_path: Path, base_dir: Path, minify: bool, dry_run: bool) -> None:
    """将 base_dir 下所有内容打包为 ZIP，保持目录结构。"""
    if not base_dir.exists() or not base_dir.is_dir():
        print(f"错误: 基准目录不存在或不是目录 - {base_dir}")
        raise FileNotFoundError(base_dir)

    if dry_run:
        print("[DRY-RUN] 仅列出将写入 ZIP 的文件，不实际生成")

    try:
        # dry-run 时写到一个临时文件再删掉，避免污染输出目录
        target = zip_path
        tmp_zip = None
        if dry_run:
            fd, tmp_zip = tempfile.mkstemp(suffix=".zip")
            os.close(fd)
            target = Path(tmp_zip)

        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zipf:
            for file_path in sorted(base_dir.rglob("*")):
                if not file_path.is_file():
                    continue
                arcname = str(file_path.relative_to(base_dir)).replace("\\", "/")

                if minify and file_path.suffix.lower() == ".js":
                    mini = minify_js(file_path)
                    if mini is not None:
                        zipf.writestr(arcname, mini)
                        print(f"已添加(压缩): {arcname}")
                        continue
                elif minify and file_path.suffix.lower() == ".css":
                    mini = minify_css(file_path)
                    if mini is not None:
                        zipf.writestr(arcname, mini)
                        print(f"已添加(压缩): {arcname}")
                        continue

                zipf.write(file_path, arcname)
                print(f"已添加: {arcname}")

        if dry_run:
            print(f"\n[DRY-RUN] 未生成实际 ZIP（预计输出: {zip_path}）")
        else:
            print(f"\n打包完成: {zip_path}")

        if tmp_zip:
            os.unlink(tmp_zip)

    except Exception as e:
        print(f"打包 ZIP 失败: {e}")
        raise


# ----------------------------- CLI -----------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="通用 Mod 打包脚本：收集图片、更新 boot.json、可选压缩、输出 .mod.zip",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("-s", "--source", default="./Source",
                   help="Source 目录路径（包含 boot.json、img 等）")
    p.add_argument("-n", "--name", default="SmartPhone",
                   help="Mod 名称，用于生成 zip 文件名")
    p.add_argument("-o", "--output", default=".",
                   help="输出目录（zip 生成位置）")
    p.add_argument("--img-dir", default="img",
                   help="图片目录（相对 Source）")
    p.add_argument("--minify", action="store_true",
                   help="压缩 JS(terser) 与 CSS 后再打包")
    p.add_argument("--no-update-boot", action="store_true",
                   help="跳过更新 boot.json 的 imgFileList")
    p.add_argument("--dry-run", action="store_true",
                   help="只演示流程，不生成实际 zip")
    p.add_argument("-v", "--verbose", action="store_true",
                   help="输出更详细信息")
    return p


def main() -> None:
    args = build_parser().parse_args()

    base_dir = Path(args.source).resolve()
    if not base_dir.is_dir():
        print(f"错误: Source 目录不存在 -> {base_dir}", file=sys.stderr)
        sys.exit(1)

    boot_json_path = base_dir / "boot.json"
    img_dir = base_dir / args.img_dir
    output_dir = Path(args.output).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    # 1. 收集图片
    img_files = collect_images(img_dir, base_dir)

    # 2. 更新 boot.json
    config: dict = {}
    if args.no_update_boot:
        print("提示: 已跳过 boot.json 更新")
        if boot_json_path.exists():
            try:
                config = json.loads(boot_json_path.read_text(encoding="utf-8"))
            except Exception:
                config = {}
    else:
        if not boot_json_path.exists():
            print(f"错误: 未找到 boot.json -> {boot_json_path}", file=sys.stderr)
            sys.exit(1)
        config = update_boot_json(boot_json_path, img_files)

    # 3. 生成 zip 名称
    version = config.get("version", "unknown")
    zip_name = f"{args.name}-v{version}.mod.zip"
    zip_path = output_dir / zip_name

    print("=" * 50)
    print("source :", base_dir)
    print("version:", version)
    print("filename:", zip_name)
    print("minify :", args.minify)
    print("开始打包")
    print("=" * 50)

    # 4. 打包
    create_zip(zip_path, base_dir, minify=args.minify, dry_run=args.dry_run)

    print("\n完成！")


if __name__ == "__main__":
    try:
        main()
        time.sleep(0.5)
    except Exception:
        print("=" * 50)
        traceback.print_exc()
        input()