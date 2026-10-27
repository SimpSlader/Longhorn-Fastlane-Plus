#!/usr/bin/env python3
"""Update only the verified unpacked installation; never remove user files."""
import datetime
import hashlib
import fnmatch
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import local_config  # noqa: E402  (machine-specific values come from the git-ignored fastlane.local.json)

_CONFIG = local_config.load()
REPO = Path(_CONFIG['repo'])
TARGET = Path(_CONFIG['extensionDir'])
PROFILE = Path(_CONFIG['chromeProfileDir'])
EXTENSION_ID = _CONFIG['extensionId']
BACKUPS = Path(_CONFIG['backupDir'])


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def manifest(folder):
    data = json.loads((folder / 'manifest.json').read_text())
    require(data.get('manifest_version') == 3 and data.get('name') == 'Fastlane Course Planner',
            'Refusing a folder without the expected Fastlane MV3 manifest: ' + str(folder))
    references = [data.get('background', {}).get('service_worker'), data.get('options_page'),
                  data.get('action', {}).get('default_popup')]
    references += list(data.get('icons', {}).values())
    icon = data.get('action', {}).get('default_icon')
    references += list(icon.values()) if isinstance(icon, dict) else [icon]
    for script in data.get('content_scripts', []):
        references += script.get('js', []) + script.get('css', [])
    for reference in filter(None, references):
        relative = Path(reference)
        require(not relative.is_absolute() and '..' not in relative.parts, 'Unsafe manifest reference')
        require((folder / relative).is_file(), 'Missing manifest asset: ' + reference)
    return data


def auto_reload_build(folder):
    return b'fastlane-dev-build.json' in b''.join(p.read_bytes() for p in (folder / 'assets').glob('*.js'))


def main():
    require(TARGET.is_dir() and TARGET.resolve() == TARGET, 'Installation folder missing or redirected')
    require(REPO.resolve() == REPO, 'Source folder redirected')
    settings = {}
    for name in ['Preferences', 'Secure Preferences']:
        path = PROFILE / name
        if path.exists():
            settings.update(json.loads(path.read_text()).get('extensions', {}).get('settings', {}))
    installed = settings.get(EXTENSION_ID, {})
    require(installed.get('location') == 4 and installed.get('path') == str(TARGET),
            'Chrome no longer associates the expected extension ID with this unpacked folder. Nothing copied.')
    # Optional personal access is read only from a local file, never source or build output.
    personal_access = None
    if _CONFIG.get('aiInviteCodeFile'):
        personal_access = Path(_CONFIG['aiInviteCodeFile']).read_text().strip()
        require(8 <= len(personal_access) <= 256 and not any(c.isspace() for c in personal_access),
                'Personal AI invite file must contain one code without spaces')
    source = REPO / 'dist'
    new, old = manifest(source), manifest(TARGET)
    if personal_access:
        require(auto_reload_build(source), 'Personal AI access requires a local development build')
        require(not any(fnmatch.fnmatch('fastlane-dev-build.json', resource)
                        for group in new.get('web_accessible_resources', [])
                        for resource in group.get('resources', [])),
                'Personal access file must not be web-accessible')
    require(new.get('key') == old.get('key'), 'Manifest identity key changed; refusing installation')
    for field in ['permissions', 'content_security_policy']:
        require(new.get(field) == old.get(field), 'Security configuration changed; review before syncing: ' + field)
    # Explicitly reviewed migrations: the user's requested click-to-import IDA button, and the opt-in
    # Fastlane AI backend (PR #8; called only after the student consents and enters the invite code), and
    # Rate My Professors ratings on course listings (approved by the user 2026-10-22; professor names only).
    old_hosts, new_hosts = set(old.get('host_permissions', [])), set(new.get('host_permissions', []))
    require(old_hosts <= new_hosts and new_hosts - old_hosts <= {
        'https://utdirect.utexas.edu/apps/degree/audits/results/*',
        'https://longhorn-fastlane-plus.vercel.app/*',
        'https://www.ratemyprofessors.com/*',
    }, 'Unreviewed host permission change; refusing installation')
    files = []
    for path in source.rglob('*'):
        require(not path.is_symlink(), 'Symlink in build: ' + str(path))
        if not path.is_file():
            continue
        relative = path.relative_to(source)
        destination = TARGET / relative
        for parent in [destination, *destination.parents]:
            if parent == TARGET.parent:
                break
            require(not parent.is_symlink(), 'Symlink in installation: ' + str(parent))
        require(not destination.exists() or destination.is_file(), 'Destination is not a file: ' + str(destination))
        files.append(relative)
    # No destination writes happen before the entire build and target pass validation and backup completes.
    BACKUPS.mkdir(parents=True, exist_ok=True)
    backup = BACKUPS / ('before-sync-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    backup.mkdir(mode=0o700)
    shutil.copytree(TARGET, backup / 'installed-extension', symlinks=True)
    files.sort(key=lambda relative: (relative == Path('manifest.json'), str(relative)))
    for relative in files:
        destination = TARGET / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=destination.parent, prefix='.fastlane-', delete=False) as temporary:
            temporary_path = Path(temporary.name)
        try:
            shutil.copy2(source / relative, temporary_path)
            os.replace(temporary_path, destination)
        finally:
            temporary_path.unlink(missing_ok=True)
    manifest(TARGET)
    for relative in files:
        require(hashlib.sha256((source / relative).read_bytes()).digest() ==
                hashlib.sha256((TARGET / relative).read_bytes()).digest(), 'Copy verification failed: ' + str(relative))
    # Written last, only after every file is copied and verified: the local build's background worker sees
    # the new stamp and reloads the extension itself, so no Reload click at chrome://extensions is needed.
    digest = hashlib.sha256()
    for relative in files:
        digest.update(str(relative).encode() + b'\0' + hashlib.sha256((TARGET / relative).read_bytes()).digest())
    stamp = {'buildId': digest.hexdigest()[:16] + '-' + datetime.datetime.now().strftime('%Y%m%d%H%M%S'),
             'syncedAt': datetime.datetime.now().astimezone().isoformat()}
    if personal_access:
        stamp['aiAccessCode'] = personal_access
    with tempfile.NamedTemporaryFile('w', dir=TARGET, prefix='.fastlane-', delete=False) as temporary:
        json.dump(stamp, temporary)
        stamp_temp = Path(temporary.name)
    os.replace(stamp_temp, TARGET / 'fastlane-dev-build.json')
    auto = auto_reload_build(source)
    print(f'Installed and verified {len(files)} files at {TARGET}')
    print(f'Build stamp: {stamp["buildId"]}' + ('' if auto else ' (auto-reload not compiled into this build)'))
    print(f'Backup: {backup}')
    print(f'Existing Chrome extension ID retained: {EXTENSION_ID}')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        raise SystemExit(f'Fastlane sync stopped: {error}') from error
