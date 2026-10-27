#!/usr/bin/env python3
"""Machine-specific settings for the local Fastlane update workflow.

Values live in `fastlane.local.json` at the repository root. That file is git-ignored; copy
`fastlane.local.example.json` to create it. Nothing machine-specific is stored in tracked files.

Usage from shell:  python3 scripts/local/local_config.py <key>   (prints one value)
"""
import json
import re
import sys
from pathlib import Path

CONFIG_PATH = Path(__file__).resolve().parents[2] / 'fastlane.local.json'
PATH_KEYS = ('repo', 'toolchainBin', 'extensionDir', 'chromeProfileDir', 'backupDir')
KEYS = PATH_KEYS + ('extensionId', 'branch')


def load():
    if not CONFIG_PATH.is_file():
        raise SystemExit(
            f'Missing {CONFIG_PATH.name}. Copy fastlane.local.example.json to fastlane.local.json and fill in your paths.')
    data = json.loads(CONFIG_PATH.read_text())
    missing = [key for key in KEYS if not isinstance(data.get(key), str) or not data[key].strip()]
    if missing:
        raise SystemExit(f'{CONFIG_PATH.name} is missing: {", ".join(missing)}')
    for key in PATH_KEYS:
        if not Path(data[key]).is_absolute() or '<' in data[key]:
            raise SystemExit(f'{CONFIG_PATH.name}: "{key}" must be an absolute path (placeholder not replaced?)')
    if not re.fullmatch(r'[a-p]{32}', data['extensionId']):
        raise SystemExit(f'{CONFIG_PATH.name}: "extensionId" must be the 32-letter ID shown at chrome://extensions')
    result = {key: data[key] for key in KEYS}
    invite_path = data.get('aiInviteCodeFile')
    if invite_path:
        if not isinstance(invite_path, str) or not Path(invite_path).is_absolute():
            raise SystemExit(f'{CONFIG_PATH.name}: "aiInviteCodeFile" must be an absolute path')
        result['aiInviteCodeFile'] = invite_path
    return result


if __name__ == '__main__':
    if len(sys.argv) != 2 or sys.argv[1] not in KEYS:
        raise SystemExit('Usage: local_config.py <' + '|'.join(KEYS) + '>')
    print(load()[sys.argv[1]])
