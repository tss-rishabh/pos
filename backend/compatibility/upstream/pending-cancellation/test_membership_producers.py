"""Read-only source composition/producer checks; no application or SQL startup."""

import ast
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import prepare_membership_producers as prepare
from membership_fence import definitions


class MembershipProducerTests(unittest.TestCase):
    def test_saved_artifacts_are_exact_without_rewriting(self):
        for path, body in prepare.outputs().items():
            self.assertEqual(path.read_text(), body, path.name)

    def test_all_original_writers_are_guarded_and_only_actual_order_block_stages(self):
        changed = prepare.api_candidates()
        dal = ast.parse(changed["controllers/user/userDal.py"][1])
        writers = [
            node
            for node in dal.body
            if isinstance(node, ast.FunctionDef)
            and any(
                isinstance(decorator, ast.Name) and decorator.id == "membership_user_lock"
                for decorator in node.decorator_list
            )
        ]
        self.assertEqual({node.name for node in writers}, prepare.MUTATORS)
        controller = ast.parse(changed["controllers/OrderController.py"][1])
        stages = [
            node
            for node in ast.walk(controller)
            if isinstance(node, ast.With)
            and any(
                isinstance(item.context_expr, ast.Call)
                and isinstance(item.context_expr.func, ast.Name)
                and item.context_expr.func.id == "membership_order_stage"
                for item in node.items
            )
        ]
        self.assertEqual(len(stages), 1)
        stage = ast.unparse(stages[0])
        self.assertIn("set_exclusive_user(member_stage.session", stage)
        self.assertIn("set_exclusive_upgrade_user(member_stage.session", stage)
        self.assertEqual(len(definitions()), 4)

    def test_approved_refund_and_membership_patches_compose_in_either_order(self):
        refunds = ROOT.parent / "offline-cash-pricing/patches/refund-by-hp-id.patch"
        membership = ROOT / "api-v2-membership-producers.patch"
        results = []
        for patches in ((refunds, membership), (membership, refunds)):
            with tempfile.TemporaryDirectory(prefix="pos-membership-composition-") as temporary:
                directory = Path(temporary)
                for name, (original, _) in prepare.api_candidates().items():
                    path = directory / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(original)
                (directory / "middleware").mkdir()
                for patch in patches:
                    subprocess.run(
                        ["patch", "--batch", "--forward", "-p1", "-i", str(patch)],
                        cwd=directory,
                        check=True,
                        capture_output=True,
                    )
                results.append(
                    {
                        str(path.relative_to(directory)): path.read_text()
                        for path in directory.rglob("*.py")
                    }
                )
        self.assertEqual(results[0], results[1])
        ast.parse(results[0]["controllers/OrderController.py"])
        self.assertIn(
            "order_product['prod_id'], order_product['id']",
            results[0]["controllers/OrderController.py"],
        )


if __name__ == "__main__":
    unittest.main()
