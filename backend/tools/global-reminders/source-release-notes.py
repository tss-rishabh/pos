"""Render the exact pinned informational partial; context roles are explicit fixtures.

This is a template oracle, not an authentication/view certification. Candidate
identity/role checks are independently performed through real native HTTP sessions.
"""
import hashlib
import json
import re
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path
from types import SimpleNamespace

PIN = '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'


class Content(HTMLParser):
    def __init__(self):
        super().__init__()
        self.old = []
        self.new = []
        self.headings = []
        self.text = []
        self.kind = None
        self.buffer = []
        self.heading = None
        self.heading_buffer = []
        self.badges = 0

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        classes = values.get('class', '').split()
        if tag == 'span' and ('wn-old' in classes or 'wn-new' in classes):
            self.kind = 'old' if 'wn-old' in classes else 'new'
            self.buffer = []
        if tag == 'span' and 'whatsnew-badge' in classes:
            self.badges += 1
        if tag == 'h3':
            self.heading = tag
            self.heading_buffer = []

    def handle_data(self, value):
        self.text.append(value)
        if self.kind:
            self.buffer.append(value)
        if self.heading:
            self.heading_buffer.append(value)

    def handle_endtag(self, tag):
        if tag == 'span' and self.kind:
            getattr(self, self.kind).append(' '.join(''.join(self.buffer).split()))
            self.kind = None
        if tag == self.heading:
            self.headings.append(' '.join(''.join(self.heading_buffer).split()))
            self.heading = None


def main():
    root = Path(sys.argv[1]).resolve()
    assert subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip() == PIN
    filename = 'users/templates/admin/includes/whatsnew.html'
    raw = subprocess.check_output(['git', '-C', str(root), 'show', PIN + ':' + filename])
    text = raw.decode()
    assert 'localStorage' not in text
    import django
    assert django.get_version() == '4.2.5'
    from django.conf import settings
    settings.configure(SECRET_KEY='synthetic-notes-render-only', USE_I18N=False, USE_L10N=False)
    from django.template import Context, Engine
    template = Engine(debug=False).from_string(text)
    roles = []
    for role in [1, 2, 3, 4, 5]:
        rendered = template.render(Context({'user': SimpleNamespace(role=role), 'whatsnew_floating': True}))
        parsed = Content()
        parsed.feed(rendered)
        mappings = list(map(list, zip(parsed.old, parsed.new)))
        assert mappings == [['Merchant', 'OPM'], ['Staff', 'SM'], ['Cashier', 'Staff']]
        report = any('Cashier Performance' in title for title in parsed.headings)
        assert report == (role == 1)
        date = re.search(r'Updated\s+(\d+\s+[A-Za-z]+\s+\d{4})', ' '.join(parsed.text))
        assert date and ' '.join(date[1].split()) == '8 Sep 2026'
        assert parsed.badges == 1
        roles.append({'role': role, 'mappings': mappings, 'headings': parsed.headings,
                      'reportNote': report, 'updated': '8 Sep 2026', 'dateTime': '2026-09-08',
                      'newBadge': True, 'renderSha256': hashlib.sha256(rendered.encode()).hexdigest()})
    json.dump({'sourceCommit': PIN, 'sourceHashes': {filename: hashlib.sha256(raw).hexdigest()},
               'roles': roles, 'scope': 'Informational partial render only; no whole-layout/auth/view certification.'}, sys.stdout)


if __name__ == '__main__':
    try:
        main()
    except Exception as failure:
        json.dump({'error': 'SOURCE_RELEASE_NOTES_RENDER_FAILED', 'kind': type(failure).__name__}, sys.stdout)
        sys.exit(1)
