"""Execute only pure validators from the pinned Django dependency, without Django startup."""
import ast
import functools
import gzip
import json
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(__file__).with_name('django_4_2_5_password_validation.py')


class ValidationError(Exception):
    def __init__(self, message, code=None, params=None):
        self.code = code


class FieldDoesNotExist(Exception):
    pass


class Metadata:
    def get_field(self, name):
        raise FieldDoesNotExist()


names = {'MinimumLengthValidator', 'exceeds_maximum_length_ratio',
         'UserAttributeSimilarityValidator', 'CommonPasswordValidator', 'NumericPasswordValidator'}
tree = ast.parse(SOURCE.read_text())
selected = ast.Module(body=[node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names], type_ignores=[])
namespace = {'gzip': gzip, 're': re, 'Path': Path, 'SequenceMatcher': SequenceMatcher,
             'cached_property': functools.cached_property, 'ValidationError': ValidationError,
             'FieldDoesNotExist': FieldDoesNotExist, '_': lambda message: message,
             'ngettext': lambda singular, plural, count: singular if count == 1 else plural,
             '__file__': str(SOURCE)}
exec(compile(selected, str(SOURCE), 'exec'), namespace)
validators = [namespace['UserAttributeSimilarityValidator'](), namespace['MinimumLengthValidator'](),
              namespace['CommonPasswordValidator'](ROOT / 'resources/auth/common-passwords.txt.gz'),
              namespace['NumericPasswordValidator']()]
output = []
for case in json.load(sys.stdin):
    user = SimpleNamespace(**case['account'], _meta=Metadata())
    codes = []
    for validator in validators:
        try:
            validator.validate(case['password'], user)
        except ValidationError as error:
            codes.append(error.code)
    output.append(codes)
json.dump(output, sys.stdout)
