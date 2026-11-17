"""Inspect pinned syntax only; never import the POS application or its settings."""
import ast
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

PIN = '78d5b63d6a149a6bf2c748fa1d191799c59ecb8a'
BACKEND = Path(__file__).resolve().parents[2]
SOURCE = BACKEND.parent.parent / 'backend-pos-web'
NAMES = {'DailyRetailMetricsReport', 'AjaxDailyRetailMetricsReport'}
ROUTES = {'daily_retail_metrics_report', 'ajax_daily_retail_metrics_report'}
TEMPLATES = [
    'report/templates/bd_report/daily_report_matric_upload.html',
    'report/templates/bd_report/daily_report_matric_report_datatable.html',
]


def source(path):
    result = subprocess.run(
        ['git', 'show', PIN + ':' + path], cwd=SOURCE,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
    )
    if result.returncode:
        raise ValueError('Pinned source is unavailable.')
    return result.stdout.decode('utf-8')


def audit():
    views = source('report/views.py')
    datatable = source('report/datatables/bd_report.py')
    for text in [views, datatable]:
        if any(isinstance(node, ast.ClassDef) and node.name in NAMES
               for node in ast.walk(ast.parse(text))):
            raise ValueError('A prototype view became executable.')
    if '# class DailyRetailMetricsReport(' not in views or \
            '# class AjaxDailyRetailMetricsReport(' not in datatable:
        raise ValueError('The expected source prototype changed.')

    inventory = json.loads((BACKEND / 'parity/legacy-inventory.json').read_text())
    if inventory['source_commit'] != PIN:
        raise ValueError('The source inventory baseline changed.')
    active_routes = inventory['routes']
    if any(name in json.dumps(route) for route in active_routes for name in ROUTES):
        raise ValueError('A source route for the prototype is registered.')
    urls = source('report/urls.py')
    for node in ast.walk(ast.parse(urls)):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value in ROUTES:
            raise ValueError('The report URL module registers a prototype route.')
    if any(name not in urls for name in ROUTES):
        raise ValueError('The commented route evidence changed.')

    # Django ignores this complete block, including its missing reverse name.
    sidebar = source('users/templates/admin/includes/sidebar.html')
    blocks = list(re.finditer(r'{%\s*comment\s*%}.*?{%\s*endcomment\s*%}', sidebar, re.S))
    token = "{% url 'daily_retail_metrics_report' %}"
    if sidebar.count(token) != 1 or not any(token in block.group() for block in blocks):
        raise ValueError('The prototype navigation is no longer fully commented.')

    template_hashes = {}
    for path in TEMPLATES:
        text = source(path)
        template_hashes[path] = hashlib.sha256(text.encode()).hexdigest()
        if any(isinstance(node, ast.Constant) and isinstance(node.value, str)
               and node.value == path.removeprefix('report/templates/')
               for tree in [ast.parse(views), ast.parse(datatable)]
               for node in ast.walk(tree)):
            raise ValueError('An executable report view now references the prototype template.')
    return {
        'sourceCommit': PIN,
        'activeViewDefinitions': 0,
        'registeredRoutes': 0,
        'activeTemplateReferences': 0,
        'sidebarLink': 'inside-django-comment',
        'templatesRetained': template_hashes,
        'applicationImported': False,
        'externalRequests': 0,
    }


if __name__ == '__main__':
    try:
        print(json.dumps(audit(), sort_keys=True))
    except Exception:
        # Static failure only: never echo source contents, settings or exceptions.
        sys.stderr.write('BUSINESS_METRICS_SOURCE_AUDIT_FAILED\n')
        sys.exit(1)
