"""Extract the legacy public surface without importing Django or executing it.

Do not retain arbitrary source string values: configuration may contain secrets.
The resulting ledger tracks missing work, not claimed implementation coverage.
"""
import ast
import hashlib
import json
from pathlib import Path
import subprocess


def literal(node, default=None):
    try:
        return ast.literal_eval(node)
    except (ValueError, TypeError):
        return default


def inventory(root):
    routes, models, functions, raw_sql, templates, jobs, sockets, administration = [], [], [], [], [], [], [], []
    sources = []
    for path in sorted(root.rglob('*')):
        if not path.is_file() or '.git' in path.parts or 'node_modules' in path.parts:
            continue
        rel = str(path.relative_to(root))
        if path.suffix not in ('.py', '.html'):
            continue
        source = path.read_text(errors='replace')
        sources.append({'path': rel, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
        if path.suffix == '.html':
            templates.append({'id': rel, 'path': rel, 'lines': len(source.splitlines()), 'status': 'unverified', 'tests': []})
            continue
        tree = ast.parse(source)
        for node in ast.walk(tree):
            if path.name == 'admin.py' and isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'register' and node.args:
                administration.append({'id': f'{rel}:{node.lineno}', 'file': rel, 'line': node.lineno, 'models': [ast.unparse(arg) for arg in node.args], 'status': 'unverified', 'tests': []})
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ('path', 're_path'):
                if len(node.args) < 2:
                    continue
                route = literal(node.args[0], ast.unparse(node.args[0]))
                view = ast.unparse(node.args[1])
                mounted = next((literal(n.args[0]) for n in ast.walk(node.args[1]) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == 'include' and n.args), None)
                name = next((literal(k.value) for k in node.keywords if k.arg == 'name'), None)
                item = {'id': f'{rel}:{node.lineno}', 'file': rel, 'line': node.lineno, 'route': route, 'view': view, 'name': name, 'include': mounted, 'status': 'unverified', 'tests': []}
                (sockets if 'websocket_urlpatterns' in source and path.name == 'routing.py' else routes).append(item)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in ('execute', 'raw', 'executemany'):
                raw_sql.append({'file': rel, 'line': node.lineno, 'operation': node.func.attr})
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                functions.append({'file': rel, 'line': node.lineno, 'name': node.name, 'end_line': node.end_lineno})
                decorators = [ast.unparse(d) for d in node.decorator_list]
                if any('task' in d for d in decorators):
                    jobs.append({'id': f'{rel}:{node.lineno}', 'file': rel, 'line': node.lineno, 'name': node.name, 'status': 'unverified', 'tests': []})
        if path.name == 'models.py':
            for node in tree.body:
                if not isinstance(node, ast.ClassDef):
                    continue
                table, fields = None, []
                for child in node.body:
                    if isinstance(child, ast.ClassDef) and child.name == 'Meta':
                        for setting in child.body:
                            if isinstance(setting, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'db_table' for t in setting.targets):
                                table = literal(setting.value)
                    is_field = isinstance(child, ast.Assign) and isinstance(child.value, ast.Call) and (
                        (isinstance(child.value.func, ast.Attribute) and isinstance(child.value.func.value, ast.Name) and child.value.func.value.id == 'models')
                        or (isinstance(child.value.func, ast.Name) and child.value.func.id == 'LegacyForeignKey')
                    )
                    if is_field:
                        options = {k.arg: literal(k.value) for k in child.value.keywords if k.arg in ('db_column', 'null', 'max_length', 'max_digits', 'decimal_places', 'primary_key', 'unique')}
                        name = child.targets[0].id
                        kind = child.value.func.attr if isinstance(child.value.func, ast.Attribute) else 'ForeignKey'
                        fields.append({'name': name, 'type': kind, 'column': options.get('db_column', name + '_id' if kind in ('ForeignKey', 'OneToOneField') else name), 'options': options})
                models.append({'file': rel, 'line': node.lineno, 'name': node.name, 'table': table, 'bases': [ast.unparse(b) for b in node.bases], 'fields': fields})
    commit = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
    return {'source_commit': commit, 'routes': routes, 'websockets': sockets, 'administration': administration, 'models': models, 'functions': functions, 'raw_sql_calls': raw_sql, 'templates': templates, 'jobs': jobs, 'source_hashes': sources}


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parents[3] / 'backend-pos-web')
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'parity/legacy-inventory.json')
    args = parser.parse_args()
    result = inventory(args.source.resolve())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k: len(v) for k, v in result.items() if isinstance(v, list)}))
