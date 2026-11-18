"""Inventory static DataTables action candidates; never certify feature parity.

Reads only pinned original templates. Dynamic JavaScript, non-table controls,
reachability and replacement behavior require manual source review. Output
contains locations and finite action names, never application data or payloads.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import subprocess


BACKEND = Path(__file__).resolve().parents[2]
ACTIONS = {
    'csv': 'csv', 'csvHtml5': 'csv', 'copy': 'copy', 'copyHtml5': 'copy',
    'excel': 'excel', 'excelHtml5': 'excel', 'pdf': 'pdf', 'pdfHtml5': 'pdf',
    'print': 'print', 'colvis': 'column-visibility', 'pageLength': 'page-length',
}
# Strings precede comments so quoted URLs and comment markers remain strings.
TOKENS = re.compile(
    r"(?P<string>'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\")"
    r'|(?P<template>`(?:\\.|[^`\\])*`)'
    r'|(?P<comment>//[^\n]*|/\*[\s\S]*?\*/)'
    r'|(?P<identifier>[A-Za-z_$][\w$]*)|(?P<punctuation>[^\s])'
)


def mask_comments(text):
    return re.sub(
        r'<!--[\s\S]*?-->|\{%\s*comment\s*%\}[\s\S]*?\{%\s*endcomment\s*%\}|\{#[\s\S]*?#\}',
        lambda match: ''.join('\n' if char == '\n' else ' ' for char in match[0]),
        text,
    )


def candidates(text):
    text = mask_comments(text)
    found = {}
    for script in re.finditer(r'<script\b[^>]*>([\s\S]*?)</script\s*>', text, re.I):
        tokens = [token for token in TOKENS.finditer(script[1])
                  if token.lastgroup not in ('comment', 'template')]

        def literal(token):
            value = token[0]
            return value[1:-1] if token.lastgroup == 'string' else value

        def record(token, syntax):
            extension = literal(token)
            if extension not in ACTIONS:
                return
            offset = script.start(1) + token.start()
            found[offset] = {
                'line': text.count('\n', 0, offset) + 1,
                'action': ACTIONS[extension], 'extension': extension, 'syntax': syntax,
            }

        for index, token in enumerate(tokens[:-2]):
            if tokens[index + 1][0] != ':':
                continue
            key = literal(token)
            value = tokens[index + 2]
            if key == 'extend' and value.lastgroup == 'string':
                record(value, 'extend')
            if key != 'buttons' or value[0] != '[':
                continue
            # Only direct string elements: object properties are handled above.
            stack = ['[']
            element_start = True
            for item in tokens[index + 3:]:
                spelling = item[0]
                if item.lastgroup == 'string':
                    if len(stack) == 1 and element_start:
                        record(item, 'buttons-array')
                    element_start = False
                    continue
                if spelling in ('[', '{', '('):
                    stack.append(spelling)
                elif spelling in (']', '}', ')'):
                    stack.pop()
                    if not stack:
                        break
                element_start = len(stack) == 1 and spelling == ','
    return [found[offset] for offset in sorted(found)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, default=BACKEND.parent.parent / 'backend-pos-web')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    inventory = json.loads((BACKEND / 'parity/legacy-inventory.json').read_text())
    source = args.source_root.resolve()
    head = subprocess.run(['git', '-C', str(source), 'rev-parse', 'HEAD'],
                          check=True, capture_output=True, text=True).stdout.strip()
    if head != inventory['source_commit']:
        raise ValueError('SOURCE_COMMIT_MISMATCH')
    hashes = {row['path']: row['sha256'] for row in inventory['source_hashes']}
    templates = []
    for row in sorted(inventory['templates'], key=lambda item: item['path']):
        path = row['path']
        filename = (source / path).resolve()
        if not filename.is_relative_to(source):
            raise ValueError('SOURCE_PATH_OUTSIDE_ROOT')
        data = filename.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if digest != hashes[path]:
            raise ValueError('SOURCE_TEMPLATE_HASH_MISMATCH: ' + path)
        templates.append({'path': path, 'sha256': digest,
                          'candidates': candidates(data.decode('utf-8'))})
    counts = Counter(control['action'] for row in templates for control in row['candidates'])
    result = {
        'source_commit': head,
        'scope': 'Static DataTables action candidates in inventoried templates only.',
        'limitations': [
            'Requires manual reachability, active-control and replacement review.',
            'Dynamic actions and non-table controls are not enumerated.',
            'No implementation status or parity certification is inferred.',
        ],
        'counts': dict(sorted(counts.items())), 'templates': templates,
    }
    rendered = json.dumps(result, indent=2, ensure_ascii=False) + '\n'
    output = BACKEND / 'parity/legacy-template-controls.review.json'
    if args.check:
        if not output.exists() or output.read_text() != rendered:
            raise ValueError('TEMPLATE_CONTROL_INVENTORY_STALE')
    else:
        output.write_text(rendered)
    print(json.dumps({'templates': len(templates), 'candidate_counts': result['counts']}))


if __name__ == '__main__':
    main()
