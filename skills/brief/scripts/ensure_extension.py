#!/usr/bin/env python3
"""Install the bundled Brief VS Code extension into every VS Code profile that lacks this version.

  ensure_extension.py [--code <cli>]

A new worktree can open in any profile, so the extension goes into all of them. The script prints
one line for each profile it changed, and nothing when every profile is current.
"""

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
EXTENSION_DIR = os.path.join(os.path.dirname(HERE), "vscode-ext")


def bundled_version():
    with open(os.path.join(EXTENSION_DIR, "package.json")) as manifest:
        package = json.load(manifest)

    return f"{package['publisher']}.{package['name']}", package["version"]


def user_dir():
    if platform.system() == "Darwin":
        return os.path.expanduser("~/Library/Application Support/Code/User")

    if platform.system() == "Windows":
        return os.path.join(os.environ.get("APPDATA", ""), "Code", "User")

    return os.path.expanduser("~/.config/Code/User")


def profile_names():
    storage = os.path.join(user_dir(), "globalStorage", "storage.json")
    try:
        with open(storage) as file:
            profiles = json.load(file).get("userDataProfiles", [])
    except (OSError, ValueError):
        profiles = []

    return [None] + [profile["name"] for profile in profiles if not profile["location"].startswith("builtin")]


def installed_version(code, extension_id, profile):
    cmd = [code, "--list-extensions", "--show-versions"] + (["--profile", profile] if profile else [])
    output = subprocess.run(cmd, capture_output=True, text=True).stdout
    for line in output.splitlines():
        name, _, version = line.partition("@")
        if name.lower() == extension_id:
            return version

    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--code", default=shutil.which("code"))
    args = parser.parse_args()

    if not args.code:
        sys.exit("The `code` CLI is not on PATH. In VS Code, run 'Shell Command: Install code command in PATH'.")

    vsix = os.path.join(EXTENSION_DIR, "brief.vsix")
    extension_id, version = bundled_version()
    for profile in profile_names():
        if installed_version(args.code, extension_id, profile) == version:
            continue

        cmd = [args.code, "--install-extension", vsix, "--force"] + (["--profile", profile] if profile else [])
        subprocess.run(cmd, check=True, capture_output=True)
        print(f"installed {extension_id} {version} in profile {profile or 'Default'}")


if __name__ == "__main__":
    main()
