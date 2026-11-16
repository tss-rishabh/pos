"""Pinned patch composition and cross-language proof compatibility checks."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('prepare_ordinary_checkout', ROOT / 'ordinary/prepare_patch.py')
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class OrdinaryCompatibilityTests(unittest.TestCase):
    def test_exchange_and_ordinary_patches_compose_without_changing_source(self):
        with tempfile.TemporaryDirectory(prefix='pos-ordinary-patch-test-') as temporary:
            folder = Path(temporary)
            for filename in ['juspay/Order.go', 'juspay/model.go', 'main.go', 'auth/Auth.go']:
                destination = folder / filename
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_text(prepare.original('payments', filename))
            for filename in ['payments-pos-exchange.patch', 'payments-pos-checkout.patch']:
                command = ['git', 'apply']
                patch = str(ROOT / 'patches' / filename)
                subprocess.run(command + ['--check', patch], cwd=folder, check=True, capture_output=True)
                subprocess.run(command + [patch], cwd=folder, check=True, capture_output=True)
            order = (folder / 'juspay/Order.go').read_text()
            self.assertLess(order.index('if tryConfirmPOSCheckout(c, &o)'), order.index('CreateCustomer(c)'))
            self.assertIn('if tryConfirmPOSExchange(c, &o)', order)
            model = (folder / 'juspay/model.go').read_text()
            method = model[model.index('func (o *Order) OrderAndStockConfirmed'):]
            self.assertLess(method.index('tryConfirmPOSCheckoutInternal'), method.index('shouldReduceStock := true'))
            self.assertIn('func (o *Order) applyPOSCheckoutSource', (folder / 'juspay/pos_checkout_source.go').read_text())
            self.assertTrue((folder / 'cmd/pos-checkout-effects/main.go').is_file())
            main = (folder / 'main.go').read_text()
            self.assertIn('router := gin.New()', main)
            self.assertIn('poscheckout.PrivateHTTP(os.Getenv, os.Stdout)', main)
            self.assertNotIn('gin.Default()', main)
            self.assertNotIn('gin.Recovery()', main)
            auth = (folder / 'auth/Auth.go').read_text()
            self.assertEqual(auth, prepare.private_auth_source())
            self.assertNotIn('utils.', auth)
            self.assertIn('jot.Verify(jwt.HS512', auth)
            self.assertIn('jot.Verify(jwt.HS256', auth)
            prefix = order[order.index('func ProcessOrder(c *gin.Context)'):]
            prefix = prefix[:prefix.index('\tCreateCustomer(c)')]
            for unsafe in ['utils.Debugf(', 'utils.Warnf(', 'utils.Infof(', 'utils.Errorf(', 'utils.Db.Where(']:
                self.assertNotIn(unsafe, prefix)
            self.assertIn('utils.Db.New().LogMode(false).Where(', prefix)
            exchange = (folder / 'juspay/pos_exchange_http.go').read_text()
            self.assertIn('poscheckout.OperatorID(c.Request.Context())', exchange)
            self.assertNotIn('order.User', exchange)
            self.assertNotIn('`json:"orderId"`', exchange)
        content = prepare.patch()
        manifest = json.loads((ROOT / 'ordinary-manifest.json').read_text())
        self.assertEqual((ROOT / manifest['patch']).read_text(), content)
        self.assertEqual(manifest['sha256'], hashlib.sha256(content.encode()).hexdigest())

    def test_node_and_go_use_identical_native_mysql_hashes(self):
        node = (ROOT.parents[1] / 'src/modules/checkout/projection.ts').read_text()
        go = (ROOT / 'go/internal/poscheckout/hashes.go').read_text()
        for node_name, go_name in [('checkoutHeaderHashSql', 'HeaderHashSQL'), ('checkoutLineHashSql', 'LineHashSQL')]:
            node_hash = json.loads(re.search(r'export const ' + node_name + r'\s*=\s*("[^\n]+");', node).group(1))
            go_hash = re.search(r'const ' + go_name + r' = `([^`]+)`', go).group(1)
            self.assertEqual(node_hash, go_hash)
            self.assertIn('CAST(JSON_OBJECT(', node_hash)
            self.assertIn('AS CHAR CHARACTER SET utf8mb4),256)', node_hash)


if __name__ == '__main__':
    unittest.main()
