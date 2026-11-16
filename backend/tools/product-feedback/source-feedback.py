"""Execute pinned staff view bodies with isolated ORM/response doubles; no Django startup."""
import ast
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

root = Path(__file__).resolve().parents[4] / 'backend-pos-web'
users_source = (root / 'users/views.py').read_text()
order_source = (root / 'order/views.py').read_text()


def method(source, cls, name):
    tree = ast.parse(source)
    node = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == cls)
    fn = next(n for n in node.body if isinstance(n, ast.FunctionDef) and n.name == name)
    fn.decorator_list = []
    return compile(ast.fix_missing_locations(ast.Module(body=[fn], type_ignores=[])), '<pinned-source>', 'exec')


class Rows(list):
    def values(self, *fields):
        return Rows({field: getattr(row, field) for field in fields} for row in self)

    def order_by(self, field):
        return Rows(sorted(self, key=lambda row: (row[field] is not None, row[field] or 0)))


class Manager:
    def __init__(self, rows):
        self.rows = rows
        self.created = []

    def filter(self, **where):
        return Rows(row for row in self.rows if all(getattr(row, key) == value for key, value in where.items()))

    def create(self, **values):
        self.created.append(values)
        return SimpleNamespace(**values)


ratings = Manager([])
scope = {
    'Order': SimpleNamespace(objects=Manager([SimpleNamespace(id=9007199254740993, user_id=777, order_amt=125.5)])),
    'HasProduct': SimpleNamespace(objects=Manager([
        SimpleNamespace(order=9007199254740993, product=SimpleNamespace(id=10)),
        SimpleNamespace(order=9007199254740993, product=SimpleNamespace(id=10)),
    ])),
    'UserProductRating': SimpleNamespace(objects=ratings),
    'JsonResponse': lambda value: value,
}
exec(method(users_source, 'GetOrderFeedbackFormView', 'get_order'), scope)
exec(method(order_source, 'AjaxAddFeedback', 'post'), scope)
rotations = []
for options in ([], [0], [1], [0, 0, 1, 2, 3], [None, 0, 7]):
    ratings.rows = [SimpleNamespace(order_id=9007199254740993, prod_id=10, rating=float(i), product_rating_option_id=option, platform='IOS', comment='kept') for i, option in enumerate(options)]
    result = scope['get_order'](None, 777, 9007199254740993)
    assert len(result[0]['items']) == 2
    assert result[0]['items'][0]['feedback'] == result[0]['items'][1]['feedback']
    rotations.append([r['product_rating_option_id'] for r in result[0]['items'][0]['feedback']])
assert scope['get_order'](None, 778, 9007199254740993) == []
for option, rating in enumerate(('4.5', '0', '3.2', '0')):
    response = scope['post'](None, SimpleNamespace(POST={
        'user_id': '777', 'order_id': '9007199254740993', 'prod_id': '10',
        'product_rating_option': str(option), 'rating': rating,
        'comment': 'café € <script>' if option == 0 else '',
    }))
    assert response['status'] == '200'
assert [row['is_default'] for row in ratings.created] == [1, 0, 0, 0]
assert [row['platform'] for row in ratings.created] == ['WEB'] * 4
assert scope['post'](None, SimpleNamespace(POST={}))['status'] == '400'
print(json.dumps({
    'usersSha256': hashlib.sha256(users_source.encode()).hexdigest(),
    'orderSha256': hashlib.sha256(order_source.encode()).hexdigest(),
    'rotations': rotations,
    'created': [{**row, 'rating': float(row['rating'])} for row in ratings.created],
    'scopeVectors': 2,
}))
