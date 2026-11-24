#!/usr/bin/env python3
"""Extract factual course designations from a saved official 2026-27 UT Core HTML page.
Usage: python3 scripts/fastlane/import-core-snapshot.py official-core.html > snapshot.json
Review source, dates, pairing restrictions and policies before replacing the bundled snapshot.
"""
import hashlib
import html
import json
import re
import sys
from pathlib import Path

raw = Path(sys.argv[1]).read_bytes()
text = raw.decode()
if not re.search(r'2026[\s-]*(?:27|2027) Edition', text):
    raise SystemExit('Expected the official 2026-27 edition. A different edition needs a reviewed term scope.')
courses = {}
for part in re.split(r'<h3\b[^>]*>', text)[1:]:
    heading, _, body = part.partition('</h3>')
    match = re.search(r'Texas Core Code (0\d{2})', heading)
    if not match:
        continue
    tag = 'CORE ' + match[1]
    for value in re.findall(r'<a[^>]*class="bubblelink code"[^>]*>(.*?)</a>', body, re.S):
        code = ' '.join(html.unescape(re.sub('<[^>]+>', '', value)).split())
        if re.fullmatch(r'[A-Z][A-Z ]* \d{3}[A-Z]{0,2}', code):
            courses.setdefault(code, []).append(tag)
for tags in courses.values():
    if 'CORE 030' in tags and 'CORE 093' not in tags:
        tags.append('CORE 093')
if len(courses) < 500 or courses.get('MUS 302L') != ['CORE 050'] or 'CORE 030' not in courses.get('AST 301', []):
    raise SystemExit('The source layout changed; extraction needs review.')
print(json.dumps({
    'source': 'https://catalog.utexas.edu/general-information/academic-policies-and-procedures/core-curriculum/',
    'sourceSha256': hashlib.sha256(raw).hexdigest(),
    'effectiveTerm': 'Fall 2026', 'expiresAfterTerm': 'Summer 2027',
    'verifiedAt': '2026-10-31', 'validity': 'verified', 'courses': courses,
}, indent=4))
