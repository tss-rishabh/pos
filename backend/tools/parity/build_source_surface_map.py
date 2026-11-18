"""Deterministic implementation inventory. Never promotes release certification.

Source is read at the pinned commit. Local application/test files are only read;
the sole outputs are the two source-surface-map artifacts in backend/parity.
"""
import argparse
import ast
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import re
import subprocess

BACKEND = Path(__file__).resolve().parents[2]
WORKSPACE = BACKEND.parent
SOURCE = WORKSPACE.parent / 'backend-pos-web'
INVENTORY = BACKEND / 'parity/legacy-inventory.json'
ADMIN_MAP = BACKEND / 'parity/administration-feature-map.json'
inventory = json.loads(INVENTORY.read_text())
administration = json.loads(ADMIN_MAP.read_text())
PIN = inventory['source_commit']
EXPECTED = {'routes': 255, 'jobs': 32, 'templates': 106, 'websockets': 1, 'administration': 2}
IGNORED_INPUT_DIRECTORIES = {'.git', '.venv', 'node_modules', '__pycache__', '.cache', '.pytest_cache', '.ruff_cache', 'private'}
families = {}
route_groups = defaultdict(list)
source_cache = {}
input_hashes = {}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def pinned(path):
    if path not in source_cache:
        raw = subprocess.check_output(['git', 'show', f'{PIN}:{path}'], cwd=SOURCE)
        expected = next((row['sha256'] for row in inventory['source_hashes'] if row['path'] == path), None)
        if expected and sha(raw) != expected:
            raise ValueError(f'Source inventory hash mismatch: {path}')
        source_cache[path] = raw.decode()
    return source_cache[path]


def references(paths, base='backend'):
    output = []
    for pattern in paths:
        pattern = pattern if pattern.startswith(('backend/', 'frontend/')) else base + '/' + pattern
        matches = sorted(WORKSPACE.glob(pattern)) if any(value in pattern for value in '*?[') else [WORKSPACE / pattern]
        matches = [path for path in matches if path.exists()]
        if not matches:
            raise ValueError(f'Mapping evidence path is absent: {pattern}')
        for path in matches:
            relative = str(path.relative_to(WORKSPACE))
            if relative not in output:
                output.append(relative)
            if path.is_file():
                input_hashes[relative] = sha(path.read_bytes())
            else:
                for child in sorted(path.rglob('*')):
                    if (
                        child.is_file()
                        and not child.is_symlink()
                        and not any(part in IGNORED_INPUT_DIRECTORIES for part in child.relative_to(WORKSPACE).parts)
                        and child.suffix in ['.ts','.tsx','.sql','.py','.go','.mjs','.sh','.json','.html','.md','.css']
                    ):
                        input_hashes[str(child.relative_to(WORKSPACE))] = sha(child.read_bytes())
    return output


def review_reference(path, anchor, scope, *, source=False):
    """Bind a reviewed implementation assertion to a current unique code line.

    This locates evidence; it never infers implementation from file/test presence.
    Source exclusions use immutable pinned bytes rather than executable imports.
    """
    if source:
        text = pinned(path)
    else:
        references([path])
        text = (WORKSPACE / path).read_text()
    lines = [index for index, line in enumerate(text.splitlines(), 1) if anchor in line]
    if len(lines) != 1:
        raise ValueError(f'Implementation review anchor changed: {path}: {anchor}')
    return {'path': path, 'line': lines[0], 'anchor': anchor.strip(), 'scope': scope,
            **({'source_commit': PIN, 'sha256': sha(text.encode())} if source else {})}


def family(key, backend=(), frontend=(), tests=(), docs=(), *, state='implementation_present',
           scope='', gaps=(), external=(), required=True, notes=()):
    if key in families:
        raise ValueError(f'Duplicate family: {key}')
    families[key] = {
        'id': key, 'implementation_status': state,
        'backend': references(backend), 'frontend': references(frontend, 'frontend'),
        'tests': references(tests), 'parity_documents': references(docs),
        'implemented_scope': scope, 'remaining_code': list(gaps),
        'external_acceptance': list(external), 'code_task_required': required,
        'notes': list(notes), 'workflow_certified': False,
        'test_evidence_scope': 'Referenced source/component/native/browser tests; file presence is not an executed full source-workflow certification.',
        'reference_binding': 'Adjacent code inspected; these paths do not implement the missing source behavior.' if state=='missing' else 'Mapped component/module scope; inspect the named remaining_code boundaries before treating the whole family as implemented.',
    }


def bind(key, names, file=None):
    for route in inventory['routes']:
        if route['include']:
            continue
        if file and route['file'] != file:
            continue
        if any(re.search(r'\b' + re.escape(name) + r'\b', route['view']) for name in names):
            if key not in route_groups[route['id']]:
                route_groups[route['id']].append(key)


ADMIN_FRONT = {
    'gift-card-batches': ['src/pages/administration/gift-card-batches'],
    'stores': ['src/pages/administration/stores.tsx'],
    'store-images': ['src/pages/administration/store-images.tsx'],
    'store-slack-oauth': ['src/pages/administration/slack-return.ts'],
    'postal-code-location': ['src/pages/administration/locations.ts'],
    'special-permission-history': ['src/pages/administration/permission-history.tsx'],
    'inherited-administration-history': ['src/pages/administration/history'],
    'staff-installer-handoff': ['src/pages/administration/application-links'],
    'customer-application-handoff': ['src/pages/administration/application-links'],
    'location-codes': ['src/pages/administration/stores.tsx'],
    'storage': ['src/pages/administration/store-resources.tsx'],
    'counters': ['src/pages/administration/store-resources.tsx'],
    'salespeople': ['src/pages/administration/people.tsx'],
    'operators': ['src/pages/administration/people.tsx'],
    'operator-mfa': ['src/pages/administration/mfa.tsx'],
    'operator-administrative-profile': ['src/pages/administration/operator-administration.tsx'],
    'model-administration-access': ['src/pages/administration/access.tsx'],
    'check-in': ['src/pages/administration/check-in.tsx'],
    'inventory': ['src/pages/operations.tsx', 'src/pages/catalog'],
    'inventory-imports': ['src/pages/administration/imports.tsx'],
    'pos-catalog': ['src/pages/counter.tsx'],
    'support': ['src/pages/administration/settings.tsx'],
    'terminals': ['src/pages/administration/terminals.tsx'],
    'documentation': ['src/pages/administration/documentation.tsx'],
}


def define_families():
    # Reuse the reviewed administration source mapping, without reclassifying its
    # existing release/certification ledger or copying stale gate descriptions.
    for row in administration['features']:
        key = row['id']
        if key == 'ecommerce-inventory-sync':
            # The cross-service family below includes the concrete receiver and
            # worker in addition to the administration route membership.
            for route in row['source_route_declarations']:
                route_groups[route['id']].append(key)
            continue
        state, gaps, external = 'implementation_present', [], []
        if key in ['store-images', 'documentation']:
            external = ['Accept configured private S3/CORS and physical supported files; synthetic storage tests are not live storage acceptance.']
        if key in ['store-slack-oauth']:
            external = ['Accept actual configured Slack workspace/grant and web/Electron OAuth round trips.']
        if key in ['staff-installer-handoff', 'customer-application-handoff']:
            external = ['Accept approved installer/provider/destination and legacy printed-link rollout; no mobile application build is required.']
        if key in ['model-administration-access', 'inherited-administration-history']:
            external = ['Reconcile the operational auth/group/actor namespace and complete source import/history publication; visible tss.auth_user and pos_user are not interchangeable.']
        if key in ['inventory', 'inventory-imports', 'pos-catalog']:
            external = ['Accept selected shared stock projection/synchronization and source pricing/data contracts before live activation.']
        if key in ['gift-card-batches']:
            external = ['Accept actual encrypted ZIP recipient clients, private storage/mail, external issuance fencing and missing historical warehouse publication.']
        if key in ['special-permission-history', 'inherited-administration-history', 'inventory-imports']:
            external += ['Publish missing historical tables with exact source collation/provenance/freshness contracts; never historical MySQL fallback.']
        family(key, row['implementation'], ADMIN_FRONT[key],
               ['tests/administration', 'frontend/tests/administration'], ['parity/administration.md'],
               state=state, gaps=gaps, external=external, scope=row['scope'],
               notes=['Imported source route membership from administration-feature-map.json; its existing certification status remains unchanged.'])
        for route in row['source_route_declarations']:
            route_groups[route['id']].append(key)
        if key in ['stores', 'operators', 'salespeople', 'counters', 'storage', 'documentation']:
            page = {'stores': 'stores.tsx', 'operators': 'people.tsx', 'salespeople': 'people.tsx', 'counters': 'store-resources.tsx', 'storage': 'store-resources.tsx', 'documentation': 'documentation.tsx'}[key]
            anchor = "useAdministrationView(kind === 'counters' ? 'counters' : 'storage'" if key in ['counters', 'storage'] else "useAdministrationView('" + key + "'"
            families[key]['implementation_review'] = [
                review_reference('frontend/src/pages/administration/' + page, anchor, 'Actual active/archived collection page selects its source-specific paged/sorted view and common visible-column/page-CSV controls.'),
                review_reference('frontend/src/pages/administration/collection-table.tsx', 'export function AdministrationCollectionTable', 'Shared control renders source page-size/sort/column choices and loaded-page CSV; full current collection export uses the existing protected queue.'),
                review_reference('backend/src/modules/administration/collection-export.ts', 'export function administrationCollectionExport(', 'Actual source-authorized renderer uses finite resource/column/sort input, bounded primary current rows and the existing queue artifact lifecycle.'),
            ]
            families[key]['implemented_scope'] += ' Actual collection controls now bind page size, server sort, visible columns and loaded-page CSV; full export is a distinct private queued action.'
        if key == 'stores':
            families[key]['implementation_review'] += [
                review_reference('backend/src/modules/administration/store-detail-routes.ts', 'export function registerAdministrationStoreDetails(', 'Actual selected-store detail/PNG endpoints recheck current native scope and encode only the exact static public marketing URL, not a login/application capability.'),
                review_reference('frontend/src/pages/administration/stores.tsx', '<StoreDetailDialog', 'Actual store row opens its selected-store detail/marketing QR action; checked-in application handoff remains separate.'),
            ]
        if key == 'terminals':
            families[key]['implementation_review'] = [
                review_reference('backend/src/modules/administration/index.ts', 'registerTerminalDirectory(app, db);', 'Actual administration registrar mounts the credential-free EDC directory.'),
                review_reference('backend/src/modules/administration/terminal-directory.ts', 'export function registerTerminalDirectory(', 'Pine/Paytm union applies fresh role/current assigned-store authority, finite provider/search/sort and bounded primary paging; credential fields are not selected.'),
                review_reference('frontend/src/pages/administration/terminal-directory.tsx', 'export function TerminalDirectory(', 'Actual provider directory offers nonsecret columns, visibility/page choices and page/full CSV while preserving the independent write-only editor.'),
            ]
            families[key]['parity_documents'] += references(['parity/terminal-directory.md'])

    family('system-health', ['src/app.ts'], ['src/components/error-boundary.tsx'],
           ['tests/api.test.ts', 'tests/logging.test.ts'], scope='Liveness/readiness and safe application error boundary.')
    bind('system-health', ['HealthCheckView'])
    family('country-search', ['src/modules/administration/country-search.ts', 'src/modules/administration/service.ts'], ['src/pages/administration/secondary-countries.tsx', 'src/pages/administration/stores.tsx'],
           ['tests/administration/barcodes', 'frontend/tests/administration/barcodes'], ['parity/administration-barcodes-country.md'],
           scope='Separate source sec_status=1/literal icontains secondary-country POST search, exact blank/whitespace/physical-collation behavior and authenticated lookup UI; standard status=1 directory/postal autofill remains distinct.',
           notes=['Source store-form Select2 country controls are commented; active postal autofill is not silently changed to the secondary predicate.'])
    bind('country-search', ['GetCountryNameView'])
    family('catalog-read', ['src/modules/catalog-details', 'src/modules/catalog.ts'], ['src/pages/catalog'], ['tests/catalog-details', 'tests/administration/barcodes/mysql.test.ts', 'frontend/tests/catalog'],
           ['parity/catalog-details.md'], scope='Product list/detail/matrix, source field/sort/search profiles and distinct seven-column per-store catalogue snapshot.',
           external=['Accept actual duplicate GS1/ambiguous membership-price data and configured historical collation/publication contracts.'],
           notes=['Main store-picker global bypass is internal role1 only; every franchise role receives assigned active FRANCHISE stores, and empty assignments return empty. Native role1–5/type1–2 matrix preserves nullable DTO fields.'])
    bind('catalog-read', ['ProductsView', 'AjaxProductsListView', 'ShowProductView', 'CatalogueView', 'AjaxCatalogueView'])
    family('inventory-audit', ['src/modules/catalog-details/audit.ts'], ['src/pages/catalog'], ['tests/catalog-details', 'frontend/tests/catalog'],
           ['parity/catalog-details.md'], scope='Product/hold/storage audit profiles, current-day DATA reads and historical BigQuery adapters.',
           external=['Publish exact missing audit facts and source-collation views; unrelated inventory logs cannot substitute.'])
    bind('inventory-audit', ['ShowProductInventoryView', 'AjaxProductInventoryListView', 'ShowHoldStockInventoryView', 'ShowStorageStockInventoryView', 'AjaxStorageStockInventoryListView'])
    family('catalog-maintenance', ['src/modules/catalog-details/maintenance-routes.ts', 'src/modules/catalog-details/maintenance-service.ts'],
           ['src/pages/catalog'], ['tests/catalog-details', 'frontend/tests/catalog'], ['parity/catalog-details.md'],
           scope='Durable inventory pulls, exact sku sample, reviewed troubleshooting and explicit uncertain-delivery reconciliation.',
           external=['Accept upstream replay/idempotency and synchronization outcomes before dispatch activation.'])
    bind('catalog-maintenance', ['InventorySyncView', 'AjaxTroubleshootProductView', 'download_demo_file'])
    family('motivational-quotes', ['src/modules/motivational-quotes'], ['src/components/motivational-quote.tsx', 'src/pages/counter.tsx'],
           ['tests/motivational-quotes.test.ts', 'frontend/e2e/**/motivational-quotes.spec.ts'],
           scope='Exact source 83-choice immutable quote pool, authenticated bounded random API and actor-bound asynchronous refresh/offline-safe shared React card. Dashboard rotation uses the same card.',
           notes=['Source-handler differential choices and controlled browser workflows are scoped evidence; no release certification is added. Root integrates the rotating card into the new dashboard.'])
    bind('motivational-quotes', ['AjaxGetQuotesView'])
    bind('motivational-quotes', ['ShortcutDashboardView', 'CreateTabView', 'CreateOrderView'])
    family('global-barcode-assignment', ['src/modules/administration/barcodes', 'src/modules/catalog-details/maintenance-service.ts'], ['src/pages/administration/barcodes'],
           ['tests/administration/barcodes', 'tests/catalog-details/maintenance.mysql.integration.test.ts', 'frontend/tests/administration/barcodes'], ['parity/administration-barcodes-country.md'],
           scope='Source internal-role1–3 missing-barcode assignment with exact normalization/messages/conflict order, current writer authority, atomic special-permission audit/UUID receipts and scanner form with durable GET recovery; shared mutex coordinates existing suffix repair.',
           external=['Accept GS1 writer cutover/cooperative locking and duplicate-data handling across remaining legacy/API/ecommerce/import writers. Nonunique physical indexes are retained; scoped rewrite concurrency tests do not certify global uniqueness.'])
    bind('global-barcode-assignment', ['AjaxAddBarcodeView', 'SpecialPermissionView'])
    family('wallet-adjustments', ['src/modules/checkout/benefit-adjustments'], ['src/pages/checkout/benefit-adjustments'],
           ['tests/checkout', 'frontend/tests'], ['parity/wallet-adjustments.md'], scope='User-approved atomic Money/Points adjustment, FIFO/expiry ledgers, immutable recovery and global activity audits.',
           external=['Accept shared external wallet locking/writer cutover and verified legacy allocation history.'])
    bind('wallet-adjustments', ['AjaxTssMoneyView', 'AjaxAjaxTssPointsView'])
    family('global-vouchers', ['src/modules/global-vouchers'], ['src/pages/global-vouchers'], ['tests/global-vouchers', 'frontend/tests/global-vouchers'],
           ['parity/global-vouchers.md'], scope='User-approved exact-paise non-expiring issuance and verified-checkout conversion with atomic receipts, PIN budgets and quote invalidation.',
           external=['Apply reviewed ordinary-voucher exact-value/null-date/GV_ADD consumer corrections and shared writer contract; do not fabricate old gift-card funding evidence.'])
    bind('global-vouchers', ['AjaxGiftVoucherModuleView', 'AjaxGiftVoucherCheck', 'AjaxGiftVoucherConvert'])
    family('ecommerce-inventory-sync', ['src/modules/administration/settings.ts', 'src/modules/administration/settings-adapters.ts', 'src/modules/administration/ecommerce-sync', 'compatibility/upstream/ecommerce-full-sync', 'src/modules/administration/settings-worker-main.ts'],
           ['src/pages/administration/settings.tsx', 'src/pages/administration/ecommerce-sync'], ['tests/administration/ecommerce-sync', 'tests/administration/settings.test.ts', 'frontend/tests/administration/ecommerce-sync'], ['parity/administration-settings.md', 'parity/ecommerce-inventory-sync.md'],
           scope='Exact source stock>threshold association selection, bounded staged current-quantity system projections/audits and authenticated full catalog completion are wired through the existing settings queue/worker. The pinned source builder retains Mongo/Redis/Akamai transformations with guarded writer-current stock reads. Actual settings UI retains original UUIDs, cancellation fences, GET-only recovery and per-row/unknown/full-sync progress; started-only acknowledgments do not certify completion.',
           external=['Accept the selected stock/system projection candidate and actual shared writer identity; deploy the qualified private source bridge and catalog-writer cutover/coordination, then accept configured Mongo/Redis/Akamai/Slack outcomes and representative workload. No live source CALL, provider delivery or full workflow certification is inferred from component tests.'])
    bind('ecommerce-inventory-sync', ['PosEcomSetting', 'AjaxEcomSettingUpdate'])
    family('offline-scratch-invoice', ['src/modules/catalog.ts'], ['src/pages/offline-worksheet'],
           ['frontend/tests/offline-worksheet'], ['parity/offline-invoice-worksheet.md'],
           scope='Separate non-settling manual-price/customer-label invoice worksheet, exact-paise totals, source-format fourteen-column CSV and sandboxed printing; fourteen unit/oracle cases and two Chromium workflows. No payment, stock or customer write.',
           external=['Accept physical Windows/macOS worksheet printer output and the actual downstream CSV consumer; signed collected-cash receipts retain their independent fixed-price contract.'])
    bind('offline-scratch-invoice', ['OfflineBillingView', 'GetProductsWithBarcodesFromDropDown'])
    family('dashboard-summary', ['src/modules/dashboard'], ['src/pages/dashboard'], ['tests/dashboard', 'frontend/tests/dashboard'],
           ['parity/dashboard.md'], scope='Source global active store/operator counts, exact distinct parent-associated product count, scoped association totals and source current/future-year monthly series; primary/current, DATA/today and immutable-publication BigQuery history.',
           external=['Publish and accept pos-dashboard-orders-v1 common-checkpoint source/warehouse count+digest generations; independent raw CDC is insufficient. Source ambiguous different-count same-month future-year overwrites fail explicitly.'])
    bind('dashboard-summary', ['DashboardView'])
    family('shared-shell', ['src/app.ts'], ['src/app.tsx', 'src/components/common.tsx', 'src/components/error-boundary.tsx'],
           ['tests/api.test.ts', 'frontend/tests'], scope='Approved redesigned navigation, shortcut landing, safe errors, online indicator and shared layout.',
           notes=['Source LiveInternetDataView GET is an acknowledgement stub; POST references commented-out locals and does not implement a working speed-log report. No new internet telemetry is inferred.'])
    bind('shared-shell', ['ShortcutDashboardView', 'LiveInternetDataView'])
    family('identity', ['src/auth/routes.ts', 'src/auth/mfa.ts', 'src/auth/delivery.ts', 'src/auth/revocation.ts'],
           ['src/pages/login.tsx'], ['tests/auth.mysql.integration.test.ts', 'tests/otp-delivery.test.ts', 'tests/otp-delivery.test.ts'],
           [], scope='Password/MFA/login OTP, source channel/resend budgets, active-account checks, sessions/logout and monotonic revocation.',
           external=['Accept configured OTP email/SMS/WhatsApp providers and production identity tenant.'])
    bind('identity', ['CustomLoginView', 'AjaxSendLoginOtpView', 'AjaxMfaLoginView', 'CustomLogoutView'])
    family('self-profile', ['src/auth/profile.ts', 'src/auth/profile-media.ts', 'src/auth/password-policy.ts'],
           ['src/pages/profile'], ['tests/auth.mysql.integration.test.ts', 'tests/profile-image-validation.test.ts', 'frontend/tests/administration'],
           scope='Current operator profile/password/private image lifecycle and self MFA; source-policy password and current actor fences.',
           external=['Accept actual private image storage and source-account/password policy against deployment.'])
    bind('self-profile', ['ProfileView', 'CustomPasswordChangeView'])
    family('device-signin', ['src/auth/device-handoff.ts', 'src/auth/device-handoff-routes.ts', 'src/auth/device-handoff-store.ts'],
           ['src/pages/profile/device-handoff.tsx'], ['tests/device-handoff.test.ts', 'tests/device-handoff.mysql.integration.test.ts'],
           ['parity/device-handoff.md'], scope='Self QR issue/revoke and atomic trusted-service TOTP consumption under shared Redis/current auth epoch.',
           external=['Deploy coordinated device consumer/shared atomic Redis contract.'],
           notes=['The source MPosLogin password-only fallback is intentionally not exposed as a public MFA-bypassing authentication oracle; ordinary password login uses the complete MFA/session flow. No mobile app build.'])
    bind('device-signin', ['MPosLogin', 'AuthQRGen', 'AjaxGenAuthQR'])
    family('orders-read', ['src/modules/orders.ts', 'src/modules/order-history', 'src/modules/checkout/returns.ts'], ['src/pages/operations.tsx', 'src/pages/order-history'],
           ['tests/order-history', 'tests/order-search', 'tools/order-search/source_oracle.py', 'frontend/tests/order-history', 'frontend/tests/order-search', 'tests/checkout'], ['parity/order-history.md', 'parity/order-search.md', 'parity/checkout.md'],
           scope='Full ST/HL/HE/N/queue/explicit-ID order list, contact/payment/status filters, source search/sort/page and formatter/actions are integrated with 43 pinned-Django vectors and 12 browser workflows. Existing detail/paid/invoice/cancellation guards remain. PRIMARY interactive/DATA today/BigQuery old or mixed facts, live-only queue discovery, private HMAC comparisons and post-read session revocation are enforced. Demo uses an explicit synthetic adapter without a database port.',
           external=['Accept both complete common-checkpoint historical order/search publications, private contact-key generation/collation identity, real queue/current-source lifecycle and representative workload performance. Native source vectors and local browser checks are not complete production workflow certification.'])
    families['orders-read']['implementation_review'] = [
        review_reference('frontend/src/pages/operations.tsx', '<SourceOrderList', 'Actual OrdersPage mounts the source-specific search/list alongside independently authorized detail/payment controls.'),
        review_reference('frontend/src/pages/order-history/SourceOrderList.tsx', 'function exportPage()', 'Actual order-list CSV uses only the loaded page and selected visible columns; page choices 5/10/25/50/100 and source sort actions remain wired.'),
        review_reference('frontend/src/pages/order-history/search-client.ts', 'export function sourcePageCsv(', 'Loaded duplicate rows are preserved and spreadsheet formula strings neutralized; this does not certify original full-workflow or identical download bytes.'),
    ]
    bind('orders-read', ['OrdersView', 'OnlineOrdersView', 'AjaxOrderListView', 'ShowOrderDetailsView', 'ShowOnlineOrderDetailsView'])
    family('checkout-cart', ['src/modules/checkout/routes.ts', 'src/modules/checkout/service.ts', 'src/modules/checkout/customers'],
           ['src/pages/counter.tsx', 'src/pages/checkout/CheckoutReview.tsx', 'src/offline'], ['tests/checkout', 'frontend/tests', 'frontend/e2e/checkout'],
           ['parity/checkout.md'], scope='Draft tabs/sessions, connected/walk-in customers, durable cart sync/clear, quote, register, discounts, wallet/coupons/vouchers, salesperson and ordinary submission.',
           external=['Accept actual source pricing/private projection, shared wallet/stock writers and provider contracts; local receipts do not establish deployed parity.'])
    bind('checkout-cart', ['CreateTabView', 'CreateOrderView', 'AjaxCartView', 'AjaxSyncCartView', 'AjaxWalletView', 'AjaxPgDiscountView', 'AjaxStoreDiscountPGView', 'AjaxaExclusiveBenefitsView', 'AjaxGiftVoucherView', 'AjaxCouponView', 'AjaxUserRegisterView', 'AjaxValidateProcessOrderView', 'AjaxOrderView', 'AjaxAddSalesPersonView', 'AjaxAddSalesPersonPerProductView'])
    family('customer-verification', ['src/modules/customer-otp', 'src/modules/checkout/customer-verification.ts'],
           ['src/pages/checkout/CheckoutReview.tsx', 'src/pages/returns'], ['tests/customer-otp', 'tests/checkout', 'frontend/tests/customer-otp'],
           ['parity/checkout-customer-verification.md'], scope='Purpose/actor/store/customer/contact-bound queued OTP, shared budgets, fixed expiry and GET-only original operation recovery.',
           external=['Accept approved purpose-specific templates/providers and coordinated consent/contact writers; unsafe source global Redis/GET transport stays refused.'])
    bind('customer-verification', ['AjaxSendOtpView', 'AjaxVerifyOtpView'])
    family('discount-approval', ['src/modules/checkout/discounts'], ['src/pages/checkout/CheckoutReview.tsx'], ['tests/checkout'],
           ['parity/checkout.md'], scope='Source manager thresholds/role fallbacks, encrypted delivery, per-approval proof and applied-by/reviewer audit plus used email.',
           external=['Accept actual configured manager recipients and email transport.'])
    bind('discount-approval', ['AjaxPGDiscOTPSend', 'AjaxPGDiscOTPCheck'])
    family('payments', ['src/modules/checkout/payments', 'src/modules/checkout/finalizer.ts'], ['src/pages/checkout/PaymentPanel.tsx'],
           ['tests/checkout', 'frontend/tests/order-payments', 'frontend/e2e/checkout'], ['parity/order-payments.md'],
           scope='Cash/terminal/Paytm modes/init/status, source transaction adoption, received-cash notes and idempotent uncertain recovery; operator/store/order/projection fenced.',
           external=['Accept actual terminal/provider status and cancellation contracts; Paytm void is not invented.'])
    bind('payments', ['AjaxTransactionUploadView', 'AjaxTransactionCancelledView', 'AjaxTransactionStatusCheckView', 'AjaxTransactionCancelledPaytmView', 'AjaxTransactionStatusCheckPaytmView', 'AjaxGetPymentModeByOrderId', 'mpos_payment_mode', 'mpos_edc_payment_init', 'mpos_edc_status_check', 'mpos_edc_payment_cancel'])
    family('legacy-paid-reversal', ['src/modules/checkout/payment-reversals', 'src/modules/checkout/payments', 'src/modules/finance', 'src/modules/daily-report-corrections.ts'], ['src/pages/payment-reversals', 'src/pages/operations.tsx', 'src/pages/reports.tsx'], ['tests/checkout-payment-reversals', 'tests/finance', 'frontend/tests/payment-reversals', 'frontend/tests/order-payments'],
           ['parity/payment-reversals.md', 'parity/payment-correction-finance.md'], scope='Durable prepare/arm/attest/record cash-return intents, cross-manager reconciliation and retained device claims are integrated with final-finance guards. The actual Orders page has one actor/store-scoped manager queue and retains a confirmed receipt after detail refresh failure. Retained versioned proof-key reads, immutable original paid/comments history, current collection/ledger/DSR and sealed common-generation historical deltas preserve original money and event dates. Derived reversed status never completes a local sale.',
           external=['Accept the actual immutable historical publisher/source barrier, physical net cash-return attestations and supported current source funding/projection contracts before selecting the finance contract. Provider/split/offline/historical-unproved/handed-over cases require separate reconciliation, never an invented refund.'])
    bind('legacy-paid-reversal', ['AjaxPaymentStatusView'])
    family('pending-order-cancellation', ['src/modules/checkout/cancellations', 'compatibility/upstream/pending-cancellation', 'compatibility/upstream/ordinary'], ['src/pages/checkout'], ['tests/checkout'],
           ['parity/pending-order-cancellation.md', 'compatibility/upstream/pending-cancellation/membership-producers.md'], scope='Atomic pending COC cancellation, grouped stock restoration, approved expiry/wallet/GV correction and immutable receipts; source-pinned Python staging to Go activation to Node cancellation provenance producers have native concurrency/rollback evidence.',
           external=['Deploy and accept coordinated source membership producers/revision fences and shared wallet/stock writer cutover, real provider state and independently proved old funding. Reviewed compatibility patches and local source execution do not establish deployed acceptance; no fabricated historical backfill.'])
    bind('pending-order-cancellation', ['AjaxOrderCancelView'])
    family('returns-exchanges', ['src/modules/checkout/return-workflow', 'src/modules/checkout/returns.ts'],
           ['src/pages/returns'], ['tests/checkout', 'tests/return-window', 'frontend/tests/customer-otp', 'frontend/tests/return-window'], ['parity/checkout.md', 'parity/review-checkout-financial.md'],
           scope='Reason/subreason/size/payable choices, order-bound verification, accepted return/exchange saga, stock/hold/refund proof and GET recovery. Actual manager roles1-3 extension is wired in return/exchange UI to a current-authority exact order/product/HP native writer, end-of-day date, source shortening/reactivation semantics and CAS/GET recovery; changing a date never dispatches a refund.',
           external=['Accept deployed source refund/atomic exchange/stock/ledger contracts and legal credit-note provider output.'])
    families['returns-exchanges']['implementation_review'] = [
        review_reference('order/views.py', 'class AjaxExtendReturnView(', 'Active source exact order/product/HP create/update, native administrator provenance, end-of-day date and reactivation; empty date is not a clear operation.', source=True),
        review_reference('order/templates/order/show.html', 'btn btn-sm btn-danger btn-extend-return-time', 'Active source closed-window Extend Date action belongs to roles1-3; the manager action is separate from role1 cash/eligibility override.', source=True),
        review_reference('backend/src/modules/checkout/return-workflow/extensions.ts', 'export function returnWindowExtensions(', 'Actual native GET/PUT resource locks the exact tuple, preserves creation provenance, validates business dates and uses desired-state idempotency plus revision conflicts.'),
        review_reference('backend/src/modules/checkout/return-workflow/repository.ts', 'async extensionScope(', 'Extension uses current native manager/store/check-in authority, exact delivered HP, live customer/contact/OTP proof and unambiguous mapped audit actor inside the writer transaction.'),
        review_reference('backend/src/modules/checkout/return-workflow/routes.ts', 'const extensions = returnWindowExtensions(', 'Actual registered return registrar constructs and mounts the extension service; it is not an unused constructor.'),
        review_reference('frontend/src/pages/returns/index.tsx', '<ReturnWindowExtension', 'Actual return and exchange page mounts the bound source-role manager control for the selected verified line.'),
        review_reference('frontend/src/pages/returns/client.ts', 'export async function setReturnWindow(', 'Client binds PUT and returned state to the exact order/line/product and current operator; it sends no refund or guessed manager fields.'),
        review_reference('frontend/src/pages/returns/ReturnWindowExtension.tsx', 'async function refresh()', 'Unknown/conflicting save uses explicit GET-only recorded-date recovery and renewed attestation; Cancel clears local form state only.'),
    ]
    bind('returns-exchanges', ['AjaxGetSubReasonView', 'AjaxGetPayAmtView', 'AjaxProductReturnView', 'AjaxProductExchangeView', 'AjaxGetExchangeSizesView', 'AjaxGetExchangeReasonsView', 'AjaxExtendReturnView'])
    family('purchased-gift-cards', ['src/modules/checkout/gift-cards.ts', 'src/modules/checkout/payments'], ['src/pages/checkout/CheckoutReview.tsx'],
           ['tests/checkout'], ['parity/checkout.md'], scope='Saved physical gift-card serials/default/custom values/date fields with exact source Hashids and collection/funding fences.',
           external=['Accept corrected API-v2/Go issuance transaction/proof contracts; old paid statuses cannot certify historical funding.'])
    bind('purchased-gift-cards', ['AjaxCheckSaveGcView', 'AjaxSaveGcDateView'])
    family('fast-cash', ['src/modules/checkout', 'src/modules/checkout-performance'], ['src/pages/checkout/FastCashCheckout.tsx', 'src/hooks/use-checkout-performance.ts'],
           ['tests/checkout', 'tests/checkout-performance', 'frontend/tests/fast-cash', 'frontend/tests/performance-runner'], ['parity/fast-cash.md', 'parity/checkout-performance.md'],
           scope='Online fast-cash/prepaid sequence, frozen financial intent, receipt recovery and independent postpaid timing metadata.',
           external=['Accept real terminals/printers/provider and source private financial projection contracts.'])
    bind('fast-cash', ['AjaxFastCheckoutView'])
    family('cashier-shortcuts', frontend=['src/pages/cashier-shortcuts', 'src/pages/counter.tsx', 'src/pages/checkout/CheckoutReview.tsx'],
           tests=['frontend/tests/cashier-shortcuts/shortcuts.test.ts', 'frontend/e2e/checkout/cashier-shortcuts.spec.ts'], docs=['parity/cashier-shortcuts.md'],
           scope='Source R/P/PP/F/N/E/B/S/T keyboard actions and help/off preference through current eligible controls, with typing/modifier/IME/modal/actor/financial fences; no shortcut charges or completes cash.',
           state='partial', gaps=['Restore authenticated shortcut-reference access without a selected store/counter or store assignments. Source keyShortcutsView is login-only; the current help renders only inside the selection-gated counter. Preserve counter action fences while making the reference independently accessible.'])
    bind('cashier-shortcuts', ['keyShortcutsView', 'CreateOrderView'])
    family('order-to-cart-copy', ['src/modules/checkout/order-copy', 'src/modules/order-history/copy-adapter.ts'], ['src/pages/order-copy', 'src/pages/checkout/CheckoutReview.tsx', 'src/pages/counter.tsx', 'src/offline/review-snapshot.ts'],
           ['tests/checkout-order-copy', 'frontend/tests/order-copy', 'frontend/tests/offline-cash.test.ts'], ['parity/order-copy.md'],
           scope='One unit per original HP row into the current owned cart, immutable original draft, partial/result acknowledgement, native customer OTP/contact/actor authority, qualified historical facts, dedicated GET recovery and durable offline-cash origin fences. Serialized unsent cancellation claims the original command nonce; independently refreshed writer proof permits only explicit terminal clear, with GET-only lost-clear recovery and retained cash/origin markers until validated completion.',
           external=['Accept actual source cart/stock/gift-card contracts and complete historical publications. A dispatched uncertain step requires causal upstream evidence; equal cart quantities are insufficient, and collected cash is retained for manager reconciliation.'])
    bind('order-to-cart-copy', ['AjaxFetchTheProducts', 'CreateOrderView'])
    family('customer-website-handoff', ['src/modules/customer-website-handoff', 'compatibility/upstream/customer-website-handoff', 'compatibility/upstream/customer-website-handoff/PosWebsiteHandoff.php', 'compatibility/upstream/customer-website-handoff/routes.review.php', 'tools/customer-website-handoff/check-receiver.mjs'], ['src/pages/customer-website-handoff', 'src/pages/checkout/CheckoutReview.tsx'],
           ['tests/customer-website-handoff', 'frontend/tests/customer-website-handoff.test.ts'], ['parity/customer-website-handoff.md'],
           scope='Captured owner/open-checkout/version, current check-in/store/customer/shadow, original revocable session and OTP/contact consent bound to short-lived single-use opaque fragment; browser-bound original-outcome recovery and explicit handoff consent.',
           external=['Accept the actual current ecommerce receiver/session/customer writer and order-attribution contract plus exact web/Electron opener deployment. The pinned network-disabled PHP candidate is reviewable, not proof of a deployed modern-login receiver.'],
           notes=['Module owner supplied scoped native/receiver/component evidence. General JWT/api_key/contact credentials are not put in URLs, logs or browser storage.'])
    bind('customer-website-handoff', ['AjaxOnlineOrderView', 'CreateOrderView'])
    family('customer-workspace', ['src/modules/customer-insights'], ['src/pages/customer-insights'],
           ['tests/customer-profile.mysql.integration.test.ts', 'tests/customer-benefits.test.ts', 'frontend/tests/customer-profile'], ['parity/customer-history.md'],
           scope='Current private customer profile/GST/type/date/gender edits, membership/app-benefit display, bounded external insights card and historical behavior/order drilldown.',
           external=['Accept purpose-bound insight receiver, complete historical publications and private source-cache corrections.'])
    bind('customer-workspace', ['AjaxUserDetailsView', 'AjaxUserUpdateView', 'AjaxUserbehaviourView', 'AjaxCustomerInsightView', 'AjaxUpdateEndUserDataView'])
    family('customer-contacts', ['src/modules/customer-contacts', 'compatibility/customer-contacts'], ['src/pages/customer-contacts'],
           ['tests/customer-contacts', 'frontend/tests/customer-contacts'], ['parity/customer-contacts.md'],
           scope='Add-missing mobile/email two-stage verified durable claims, current checkout/contact revision, reference updates and sealed side-effect bridge.',
           external=['Deploy/accept concrete source-consumer privacy correction, OTP/effect purpose adapters and shared contact/registration writer contract.'])
    bind('customer-contacts', ['AjaxUpdateUserMobile', 'AjaxUpdateUserEmail'])
    family('product-feedback', ['src/modules/product-feedback'], ['src/pages/product-feedback'], ['tests/product-feedback.test.ts', 'tests/product-feedback.mysql.integration.test.ts', 'frontend/tests/product-feedback'],
           scope='Source order/customer/product options/rating/comment view and idempotent current-authority submission; distinct from NPS reports.')
    bind('product-feedback', ['AjaxAddFeedback', 'GetOrderFeedbackFormView'])
    family('invoice-documents', ['src/modules/invoice-documents', 'src/modules/checkout/invoices.ts'], ['src/pages/invoice-documents', 'src/pages/checkout/InvoiceActions.tsx'],
           ['tests/invoice-documents', 'frontend/tests/invoice-documents'], ['parity/invoice-documents.md'],
           scope='Protected offline/online/SDD documents, typed purpose transports, original order authorization, automatic paid/exchange preview and safe printing.',
           external=['Accept actual SDD/external legal renderer, private consumer corrections and native printer/platform output.'])
    bind('invoice-documents', ['ShowOrderInvoiceView', 'ShowOnlineOrderInvoiceView', 'ShowOnlineSDDOrderInvoiceView'])
    family('local-deliveries', ['src/modules/legacy-fulfillment'], ['src/pages/legacy-fulfillment'], ['tests/legacy-fulfillment', 'frontend/tests/legacy-fulfillment'],
           ['parity/legacy-fulfillment.md', 'parity/local-delivery-lifecycle.md'],
           scope='Original Borzo/local create/status/pack/pass/convert/cancel/RTO flows, delayed arrival/transfer/advance tasks and split-safe stock receipts.',
           external=['Accept provider/outcome adapters, source monetary/projection/cancellation cooperation and service/scheduler credentials.'])
    bind('local-deliveries', ['AjaxHlOrderView', 'AutoHlOrderView', 'AJaxConvertOnlineView', 'AjaxRtoRecievedView', 'AjaxOrderPackView', 'AjaxPassOrderView', 'WebhookCancelledOrderView', 'AjaxCheckOrderStatusView'])
    family('express-fulfillment', ['src/modules/fulfillment'], ['src/pages/fulfillment'], ['tests/fulfillment', 'frontend/tests/fulfillment'],
           ['parity/fulfillment.md'], scope='Express tabs/progress/content/load-more/reasons, bulk accept/reject/pack/ship/RTO/admin edits, expiry alerts and all-store monitoring.',
           external=['Accept actual Express courier/concurrency/status/email providers and stock cooperation.'])
    bind('express-fulfillment', ['AjaxExpressLineItemPackView', 'HyperlocalProgressView', 'AjaxHyperlocalProgressDataView', 'AjaxHyperlocalProgressContentView', 'AjaxHyperlocalRejectionReasonsView', 'AjaxExpressLineItemsBulkActionView', 'AjaxExpressOrderPackAllView', 'AjaxExpressOrderMarkShippedView', 'AjaxExpressOrderNotifyView', 'AjaxHyperlocalLoadMoreView', 'AjaxExpressOrderMarkRTOView', 'AjaxHyperlocalExpiryAlertsView', 'HyperlocalAllStoresDashboardView', 'AjaxHyperlocalAllStoresDataView', 'AjaxHyperlocalAdminEditView', 'ExpressOrderMarkShippedApiView'])
    family('shipping-labels', ['src/modules/fulfillment/shipping-label'], ['src/pages/fulfillment/shipping-label.tsx'],
           ['tests/fulfillment', 'frontend/tests/shipping-label'], ['parity/fulfillment-shipping.md'],
           scope='Express order/store label, source address/AWB/parcel fields, line quantity and safe barcode/print.',
           external=['Accept actual printer/legal/shipper layout and representative data.'])
    bind('shipping-labels', ['ShowOnlineOrderShippingView'])
    family('legacy-vinculum-status', ['src/modules/legacy-order-status', 'compatibility/upstream/whole-order-status', 'src/modules/checkout/return-workflow/repository.ts', 'src/modules/checkout/return-workflow/service.ts', 'src/modules/checkout/routes.ts'],
           ['src/pages/order-status', 'src/pages/operations.tsx'], ['tests/legacy-order-status', 'frontend/tests/legacy-order-status'],
           ['parity/whole-order-status.md', 'parity/rejected-return-repairs.md', 'compatibility/upstream/whole-order-status/private-runtime.md'],
           scope='Current-authority whole-order PACK/SHIP/DELIVER commands, immutable full HP scope, source-pinned private STORE chain, standalone private receiver and deferred Orders recovery UI are integrated separately from Express. Public/private entries compose shared cash-return/import handover fences. Durable rejected-return obligations, bounded dispatch and scoped manager recovery are integrated.',
           external=['Qualify the independently deployed source receiver, vendor and Netcore outcomes, shared-writer coordination and representative queue workload.'])
    bind('legacy-vinculum-status', ['AjaxUpdateStatusVincView'])
    family('notifications', ['src/modules/fulfillment/index.ts', 'src/modules/fulfillment/notification-bus.ts', 'src/modules/fulfillment/notifications.ts'],
           ['src/pages/fulfillment/notifications.tsx'], ['tests/fulfillment'], ['parity/fulfillment.md'],
           scope='Persisted notifications/read receipts and one store-scoped authenticated/current-check-in WebSocket subscription with expiry/backpressure.',
           external=['Accept production Redis/pubsub/websocket gateway and original consumer cutover.'])
    bind('notifications', ['AjaxNotificationUpdateView'])
    family('finance-day-close', ['src/modules/finance'], ['src/pages/finance'], ['tests/finance', 'frontend/tests/finance'],
           ['parity/finance.md', 'parity/export-history-controls.md'], scope='Day-close state/revisions/nag/pending alerts, cash-ledger/history and exact Glassbox orders feed; pending offline cash retained.',
           external=['Accept generation/CDC warehouse financial publication, source timezone/rollout and actual scheduled notices.'])
    families['finance-day-close']['implementation_review'] = [
        review_reference('frontend/src/pages/finance/ledger.tsx', '[pageSize, setPageSize] = useState(31)', 'Actual cash-balance screen restores original default 31 and 31/62/100/500 page choices after complete-chain financial calculations.'),
        review_reference('frontend/src/pages/finance/history.tsx', 'const pageCsv = useMutation(', 'Actual close-history loaded-page CSV is separate from its retained complete filtered CSV; it uses only the current authenticated bounded page.'),
    ]
    bind('finance-day-close', ['GlassboxFinanceFeedView', 'DayCloseView', 'AjaxDayCloseStateView', 'AjaxDayCloseSubmitView', 'AjaxDayCloseNagView', 'DayClosePendingAlertView', 'DayCloseLogsView', 'AjaxDayCloseLogsView', 'CashBalanceView', 'AjaxCashBalanceView'])
    family('daily-store-report', ['src/modules/reports.ts', 'src/modules/daily-report-offline.ts', 'src/modules/daily-report-warehouse.ts'],
           ['src/pages/reports.tsx'], ['tests/finance', 'tests/mysql.integration.test.ts'], ['parity/daily-report-offline.md'],
           scope='Source DSR calculations, current DATA vs historical BigQuery and offline cash/footfall/target integration.',
           external=['Accept complete financial publication/lineage and warehouse auxiliary input contracts.'])
    families['daily-store-report']['implementation_review'] = [
        review_reference('frontend/src/pages/reports.tsx', 'const totalPages = Math.max(1, Math.ceil(matchingRows.length / pageSize))', 'Actual DSR client table filters/sorts/pages loaded rows; server-calculated totals remain authoritative.'),
        review_reference('frontend/src/pages/reports.tsx', 'function download(visibleOnly = false)', 'Actual visible-column CSV is distinct from the retained complete CSV and preserves the original server totals rather than recalculating financial amounts.'),
    ]
    bind('daily-store-report', ['DailyStoreReportView', 'AjaxDailyStoreReportView'])
    family('operational-reports', ['src/modules/operational-reports'], ['src/pages/operational-reports'], ['tests/operational-reports', 'frontend/tests/operational-reports'],
           ['parity/operational-reports.md', 'parity/review-report-finance.md'], scope='NPS, returned orders, transactions, acceptance, staff performance, flash sales and hyperlocal daily profiles with complete source CSV columns. Active performance/acceptance CSV, shared column visibility and immutable submitted column/sort export bindings are wired through the real private queue/builder. Returned/flash and order-transactions retain distinct visible-column and unchanged full CSV actions. The explicitly requested all-matching-row replacement is not a claim of identical source browser-loaded-page export scope.',
           external=['Accept exact warehouse views/collations/source dimensions and actual historical data completeness.'])
    families['operational-reports']['implementation_review'] = [
        review_reference('frontend/src/pages/operational-reports/performance.tsx', 'exportKind="salesperson-performance"', 'Actual performance page selects the queued source-screen CSV kind; cashier has its distinct registered kind.'),
        review_reference('frontend/src/pages/operational-reports/acceptance.tsx', 'exportKind="hyperlocal-acceptance"', 'Actual hyperlocal acceptance page exposes the source CSV action through the common private queue.'),
        review_reference('frontend/src/pages/operational-reports/report-view.tsx', "mutationFn: (variant: 'visible' | 'full')", 'Actual visible-column export binds the submitted result filters/sort and current finite column selection; complete CSV remains a distinct action.'),
        review_reference('backend/src/modules/operational-reports/export-presentation.ts', 'export function reportColumnSelection(', 'Finite per-screen presentation allowlists reject arbitrary SQL/unknown/duplicate columns and preserve source column order.'),
        review_reference('backend/src/modules/operational-reports/export-service.ts', 'export function reportExportBuilder(', 'Actual worker builder dispatches performance/acceptance and selected-screen variants; unmarked full export retains its original query/layout.'),
        review_reference('backend/src/modules/operational-reports/screen-report-csv.ts', 'export function screenReportCsv(', 'Bounded UTF-8 CSV includes all matching rows in selected sort and original visible-column order; no truncated artifact is published.'),
    ]
    bind('operational-reports', ['ReturnOrderView', 'AjaxReturnOrderListView', 'OrdersDataView', 'AjaxOrdersDataListView', 'AjaxNpsDataListView', 'HyperlocalOrderAcceptReport', 'AjaxHyperlocalOrderAcceptReport', 'SalespersonPerformanceReport', 'AjaxSalespersonPerformanceReport', 'CashierPerformanceReport', 'AjaxCashierPerformanceReport', 'SalesDataView', 'AjaxSalesDataView', 'HyperlocalDailyReportView', 'AjaxHyperlocalDailyExportView'])
    family('inventory-parent-repair', ['src/modules/operational-reports/inventory.ts'], ['src/pages/operational-reports/inventory.tsx'],
           ['tests/operational-reports'], ['parity/operational-reports.md'], scope='Bounded writer-current missing-parent associations preserving existing stock and source child-selection semantics.')
    bind('inventory-parent-repair', ['AjaxTroubleshootInventoryView'])
    family('scheduled-reports', ['src/modules/operational-reports/scheduled-service.ts', 'src/modules/operational-reports/scheduled-worker.ts'],
           ['src/pages/operational-reports'], ['tests/operational-reports'], ['parity/scheduled-reports.md'],
           scope='Seven source report groups, bound report building, current CRM refresh and durable ordered per-target delivery/reconciliation.',
           external=['Accept approved scheduler service authority, source warehouse datasets and delivery recipients/providers.'])
    bind('scheduled-reports', ['HyperlocalSlackReport', 'HyperlocalAvailabilityReport', 'HyperlocalStoreStatusReport', 'HyperlocalDeliveryReport', 'HyperlocalCancellationReport', 'CrmTicketStatus', 'StoreHyperlocalRecord'])
    family('report-exports', ['src/modules/operational-reports/export-service.ts', 'src/modules/operational-reports/export-storage.ts', 'src/modules/operational-reports/export-worker.ts'],
           ['src/pages/operational-reports/exports.tsx'], ['tests/operational-reports', 'tests/inventory-workbooks', 'frontend/tests/operational-reports'],
           ['parity/report-exports.md', 'parity/export-history.md', 'parity/export-history-controls.md', 'parity/administration-collection-exports.md'], scope='Existing durable queue/HEAD-only unknown upload recovery, current/legacy history and protected CSV/XLSX downloads.',
           external=['Accept private bucket and missing historical export metadata publication; safe legacy package subset is not every old file.'])
    families['report-exports']['implementation_review'] = [
        review_reference('frontend/src/pages/operational-reports/exports.tsx', 'const metadataCsv = useMutation(', 'Actual export-history screen exports only selected metadata columns from its loaded authorized page, with no file-key/URL fetch or recursive export-of-exports job.'),
        review_reference('frontend/src/pages/operational-reports/export-metadata.ts', 'export function exportMetadataCsv(', 'Finite bounded metadata CSV preserves static safe messages and formula/UTF-8 guards; raw legacy error messages and file keys stay excluded.'),
    ]
    bind('report-exports', ['ExportLogsView', 'AjaxExportLogsView'])
    family('inventory-workbooks', ['src/modules/inventory-workbooks'], ['src/pages/operational-reports/exports.tsx'], ['tests/inventory-workbooks', 'frontend/tests/inventory-workbooks'],
           ['parity/inventory-workbooks.md'], scope='Literal nine-column per-selected-store workbook pipeline, bounded DATA snapshot, streaming private spool and queued lifecycle; debug task is inlined pass-through.',
           external=['Accept actual reader lag/ambiguity reconciliation and private report storage; no live upload or production timing proof is implied.'])
    family('legacy-order-imports', ['src/modules/legacy-order-imports', 'compatibility/upstream/legacy-order-imports', 'src/modules/checkout/payments/repository.ts', 'src/modules/checkout/finalizer.ts', 'src/modules/checkout/cancellations/repository.ts', 'src/modules/checkout/return-workflow'], ['src/pages/administration/order-imports'],
           ['tests/legacy-order-imports', 'tests/legacy-import-financial', 'tests/legacy-import-tender', 'tests/legacy-import-screening', 'tests/legacy-import-preparation', 'tests/import-order-holds', 'compatibility/upstream/legacy-order-imports/test_screening_runtime.py', 'frontend/tests/order-imports'], ['parity/legacy-order-imports.md', 'parity/legacy-import-financial.md', 'parity/import-order-hold-guards.md', 'parity/csv-tender-decision.md', 'parity/csv-screening-runtime.md'],
           scope='Source parsers/planners, encrypted immutable staging, current store/counter authority, job API, actor-bound recovery UI, bounded worker and qualified historical readers are integrated. Server-installed membership/provenance, automatic birthday-coupon and declared POS complementary profiles compose with actual private source creation and Go confirmation. The production Node factory now installs the screening reservation/counter lifecycle and the private WSGI factory installs its existing source wrapper, with explicit trusted line-mode agreement. The approved manager pause-and-correct workflow retains the original no-effect boundary and binds a corrected successor tender to the source calculation. Unknown outcomes remain GET-only; approval/preparation/resume never replace completed rows or original uncertain nonces.',
           external=['Accept closed-period/custom-date privilege, original source financial/Kinesis cooperation and historical publication.',
                     'Qualify actual private source settings/runtime/broker, approved schema and both fixed readonly metadata functions, distinct locked owners, current counter baseline, all cooperating writers and complete membership/coupon history publications before selecting the default-disabled profiles. Component implementation is not deployed acceptance.'],
           notes=['Earlier blanket CODE-gap wording for imported membership, birthday coupons/POS complementary allocations, screening and approved tender correction was stale; the line-bound implementation review below records the actual composition paths.',
                  'Arbitrary wallet/GV/PG spending and unrelated extra rows are not admitted: the CSV declares SKU/quantity/price, the private cart starts empty, and selected profiles prove their own additions. Refusing unbound prior cart metadata is retained; this does not claim general wallet/GV import-spending support.',
                  'The alternate dual-value tender helper remains financiallyExecutable:false review code. The selected executable policy is manager pause/correction with a definite original no-effect boundary and equality to the qualified source payable; no variance payment/refund is invented.',
                  'The two original task callers and three import/log templates remain individually inventoried as latent/shared source surfaces. Their current React/worker mappings do not certify original DOM transitions or a full source workflow.'])
    for member_family in ('checkout-cart', 'pending-order-cancellation', 'legacy-order-imports'):
        families[member_family].setdefault('implementation_review', []).append(
            review_reference('backend/src/modules/checkout/cancellations/membership-fence.ts',
                'const metadata = await readNativeHeadMetadata(tx, readNativeHeadMetadataOptions());',
                'Actual shared membership fence consumes authenticated fixed-function revision metadata under application authority without TRIGGER privileges, retaining exact bodies, native indexes/collations and revision semantics. Go/Python counterparts and independent-account workflow fixtures are integrated; this is not deployed or full-project certification.'))
        families[member_family]['parity_documents'] += references(['parity/membership-revision-head-metadata.md'])
    families['legacy-order-imports']['implementation_review'] += [
        review_reference('backend/src/app.ts', 'configuredLegacyOrderImports(config, db, {', 'Actual application registration invokes the production import factory; the profile is not a standalone unused constructor.'),
        review_reference('backend/src/modules/legacy-order-imports/worker-main.ts', 'const registration = configuredLegacyOrderImports(config, db, {', 'Standalone production worker uses that same configured import factory and its selected/blocked profile decisions.'),
        review_reference('backend/src/modules/legacy-order-imports/runtime.ts', 'export function configuredLegacyOrderImports(', 'Actual server and worker registration composes preparation, benefits, approvals, corrections and the selected screening profile.'),
        review_reference('backend/src/modules/legacy-order-imports/worker.ts', 'export function legacyOrderImportWorker(', 'Bounded production worker replaces the offline/Shopify source task entry points; original operation outcomes remain durable.'),
        review_reference('frontend/src/pages/administration/order-imports/index.tsx', 'export default function OrderImportsPage(', 'Actual role-bound offline/Shopify forms and saved job/results recovery implement the requested import workflow; the separate commented upload-log page has its explicit inactive disposition below.'),
        review_reference('backend/src/modules/legacy-order-imports/financial-adapter-profiles.ts', 'export function financialAdapterProfiles(', 'Actual financial dispatch hooks compose selected membership/benefit and screening reservation/receipt/completion gates.'),
        review_reference('backend/compatibility/upstream/legacy-order-imports/source_runtime.py', 'self.membership=MembershipProfile(source_root,self.settings) if membership_selected() else None', 'Private source installs the real membership writer and PosOrder staging composition, including Shopify pending semantics.'),
        review_reference('backend/compatibility/upstream/legacy-order-imports/membership_profile.py', 'def membership_order_tree(root):', 'Pinned membership setters run through the existing stage/provenance producer; free membership additions/replacements require source causality.'),
        review_reference('backend/src/modules/legacy-order-imports/membership-profile/adapter.ts', 'async completionSnapshot(tx, context, order)', 'Node authenticates staged/current membership descriptors and freezes completion provenance instead of assuming entitlements.'),
        review_reference('backend/compatibility/upstream/legacy-order-imports/legacy_import_membership_reference.go', 'func lockLegacyImportMembershipActivation(', 'Actual Go confirmation uses imported membership activation/reference checks before original native mutation.'),
        review_reference('backend/src/modules/legacy-order-imports/benefit-profile/composition.ts', 'export function csvFinancialBenefitProfile(', 'Server financial hooks reduce only proved membership/coupon/complementary ownership and retain exact source/native hashes.'),
        review_reference('backend/compatibility/upstream/legacy-order-imports/benefit-profile/benefit_runtime.py', 'class SourceBenefits:', 'Private source composes literal birthday-coupon and POS complementary selection, native receipts and current control/history validation.'),
        review_reference('backend/compatibility/upstream/legacy-order-imports/benefit-profile/benefit_profile.py', 'def admit_benefit_cart(', 'Allows only declared POS selections and causally proved membership additions; unbound wallet/GV/PG values remain deliberately refused.'),
        review_reference('backend/compatibility/upstream/legacy-order-imports/coupon_consumption.go', 'func lockLegacyImportCoupon(', 'Go confirmation binds actual coupon consumption to the authenticated source benefit descriptor in the native transaction.'),
        review_reference('backend/src/modules/legacy-order-imports/screening-runtime.ts', 'export function configuredCsvImportScreening(', 'Actual runtime selection requires the reviewed contracts, complete current counter/head configuration and explicit server-owned 0/1 line mode.'),
        review_reference('backend/compatibility/upstream/legacy-order-imports/runtime.py', 'pipeline=install_screening(', 'The real private WSGI factory now wraps its actual SourceRuntime, closing the previous uncalled-profile integration gap.'),
        review_reference('backend/compatibility/upstream/legacy-order-imports/screening_runtime.py', 'def install(source,selection,auth_key,proof_key,clock):', 'Source compares its actual line-item setting before installing the real ScreeningSourceRuntime; no silent enabled default.'),
        review_reference('backend/compatibility/upstream/legacy-order-imports/screening_profile.py', "expected_created_at=plan['createdAt']", 'Only the verified CSV capability/plan hands its exact historical timestamp to the creation writer; public/default callers have no override authority.'),
        review_reference('backend/compatibility/upstream/legacy-order-imports/screening_counter.py', 'def new_order(self,order):', 'Native after-flush provenance restricts the source replay to this attempt’s actual new order/lines; matching customer IDs alone do not authorize historical reads or updates.'),
        review_reference('backend/src/modules/screening-origins/native-head-capacity.ts', 'export function nativeHeadCallerGrants(', 'Shared generated row/UTF-8-byte/metadata budgets keep the actual native writer privilege catalog representable; capacity never authorizes roles, proxies, unsafe grants or head mutation.'),
        review_reference('backend/compatibility/upstream/legacy-order-imports/screening_head_metadata.go', 'func (a *headAudit) validate(', 'Actual Go financial transactions freshly authenticate full native writer/head metadata with retained locks, closed participant authority, roles/proxies and exact fixed readonly routines.'),
        review_reference('backend/src/modules/legacy-order-imports/correction-repository.ts', 'export function legacyOrderImportCorrections(', 'Approved manager workflow retains immutable original input/no-effect proof and records the corrected successor under current manager authority.'),
        review_reference('backend/compatibility/upstream/legacy-order-imports/correction_profile.py', 'def _validate(session,state,capability,plan,auth_key,proof_key,contract):', 'Private source independently authenticates the retained correction/calculation and definite original no-effect boundary before using corrected tender.'),
        review_reference('frontend/src/pages/administration/order-imports/ImportCorrectionPanel.tsx', 'export default function ImportCorrectionPanel(', 'Actual manager review/attestation/recovery UI is integrated; the alternate dual-value review candidate does not execute financial work.'),
    ]
    family('parent-store-assignment-csv', ['src/modules/administration/parent-store-imports','src/modules/administration/import-profile.ts','src/modules/administration/imports.ts','src/modules/administration/worker.ts'],
           ['src/pages/administration/parent-store-imports.tsx','src/pages/administration/imports.tsx'], ['tests/administration/parent-store-imports','tools/administration/parent-store-imports/source-oracle.py','frontend/tests/administration/parent-store-imports'], ['parity/parent-store-imports.md'],
           scope='Active three-column SkuId/StoreId/IsActive parent/store upload and retained task: source global-live family selection, audited row-atomic zero/reset/delete/recreate, strict duplicate-pair correction, durable profiled queue/control/GET recovery and source parent-ID synchronization through existing worker; six-column stock defaults are preserved.',
           external=['Accept selected atomic stock projection and replay-safe product synchronization, reconcile old pending source uploads/tasks at cutover and publish missing immutable parent-store historical job/row versions. No historical MySQL fallback.'],
           notes=['Actual source upload caller is executable. Pinned source/native/component tests do not establish deployed routine or full provider workflow certification.'])
    bind('parent-store-assignment-csv',['ProductsStoreBulkUploadView'])
    family('inactive-upload-logs', docs=['parity/review-checkout-financial.md'], state='missing', required=False,
           scope='Inactive pinned upload-log template: both list/AJAX routes and view/datatable classes are commented; the original failed-record download route and handler are also commented. The active CsvUpload model/named import tasks do not render this page.',
           notes=['No additional legacy/modern log-list or arbitrary legacy-file proxy is required by the inactive page. Existing modern exact-UUID recovery and implemented named tasks/forms remain unchanged. Preserve the source template ID and shared import-family associations without claiming a replacement history UI.'])
    families['inactive-upload-logs']['implementation_review'] = [
        review_reference('core/urls.py', '# path("upload-logs/"', 'Both upload-log list/AJAX routes are commented at the source pin; no active source page request reaches the retained template.', source=True),
        review_reference('core/views.py', '# class UploadLogsView(', 'The source list/render class is commented rather than an executable leaf.', source=True),
        review_reference('core/datatables/upload_logs_datatable.py', '# class AjaxUploadLogsView(', 'The entire retained source datatable class is commented.', source=True),
        review_reference('core/urls.py', '# path("order-punch/<int:pk>/failed-reocrds/"', 'Independent failed-record download route is also commented; it is not an active leaf hidden behind an inactive page.', source=True),
        review_reference('core/views.py', '# class DownloadFailedRecordView(', 'The failed-record download handler is commented; the retained template link does not establish executable download behavior.', source=True),
    ]
    family('source-diagnostic-task', state='missing', required=False,
           scope='create_random_user_accounts_new prints random credentials; actual User.objects.create_user is commented out.',
           notes=['No source account is created. A replacement must not print credentials or invent a new bulk-account feature; retain this diagnostic-only disposition explicitly in the job inventory.'])
    family('business-metrics-upload', ['src/modules/daily-report-warehouse.ts'], ['src/pages/reports.tsx'],
           ['tests/business-metrics-reachability.test.ts', 'tools/parity/check_business_metrics_reachability.py'], ['parity/business-metrics-prototype.md'],
           state='missing', required=False,
           scope='Inactive source prototype: both view classes, routes and template render calls are commented; the only sidebar link is inside a Django comment block. Both prototype templates remain individually inventoried with their hashes.',
           notes=['Pinned syntax/reachability audit proves no executable source upload or preview route. This is not a replacement UI or template certification. Preserve the explicit inactive-source disposition; current DSR auxiliary inputs have a separate implemented reader contract.'])
    families['source-diagnostic-task']['implementation_review'] = [
        review_reference('stores/tasks.py', 'def create_random_user_accounts_new(', 'Diagnostic prints generated values; the actual create_user call is commented. No account-writing replacement is required or selected.', source=True),
    ]
    families['business-metrics-upload']['implementation_review'] = [
        review_reference('report/views.py', '# class DailyRetailMetricsReport(', 'Upload/render class is commented source text, without an executable view or active route.', source=True),
        review_reference('report/datatables/bd_report.py', '# class AjaxDailyRetailMetricsReport(', 'Preview/datatable class is commented. Both prototype templates stay missing/inactive inventory exclusions, not a new upload product.', source=True),
    ]
    family('inherited-model-add-forms', ['src/modules/administration/model-accounts','src/modules/administration/policies.ts'],
           ['src/pages/administration/model-accounts'], ['tests/administration/model-accounts','tools/administration/model-accounts/source-oracle.py','frontend/tests/administration/model-accounts'],
           ['parity/administration-model-accounts.md'],
           scope='Actual inherited username/password-only UserAdmin creation with exact form-cleaned persisted defaults (including blank email), current reconciled superuser authority, atomic audit/UUID recovery and no fabricated commerce mirror. Pinned actual Store ModelForm/save proves submitted url_key is overwritten by existing generated URL policy; physically invalid nullable Store forms are source failures, not a new supported creation mode.',
           external=['Accept operational model grant/actor reconciliation and source business timezone. No full Django administration workflow certification.'],
           notes=['Existing managed-profile blank-email-to-NULL behavior is a separate edit-contract boundary; these exact add-form comparisons do not re-certify it.'])



JOB_FAMILIES = {
    'core/tasks.py:29': ['parent-store-assignment-csv'], 'core/tasks.py:40': ['inventory-imports'],
    'core/tasks.py:51': ['legacy-order-imports'], 'core/tasks.py:62': ['legacy-order-imports'],
    'core/tasks.py:71': ['order-messages'], 'core/tasks.py:84': ['identity'],
    'core/tasks.py:147': ['local-deliveries'], 'core/tasks.py:159': ['local-deliveries'],
    'core/tasks.py:171': ['local-deliveries'], 'core/tasks.py:182': ['ecommerce-inventory-sync'],
    'core/tasks.py:209': ['gift-card-batches'], 'core/tasks.py:226': ['legacy-vinculum-status'],
    'core/tasks.py:232': ['discount-approval'], 'core/tasks.py:271': ['discount-approval'],
    'order/tasks.py:150': ['express-fulfillment'], 'order/views.py:3839': ['local-deliveries'],
    'order/views.py:3845': ['local-deliveries'], 'order/views.py:3938': ['local-deliveries'],
    'order/views.py:4482': ['local-deliveries'],
    'report/datatables/cash_balance_datatable.py:83': ['finance-day-close', 'report-exports'],
    'report/datatables/day_close_datatable.py:216': ['finance-day-close', 'report-exports'],
    'report/datatables/hyperlocal_daily_datatable.py:40': ['operational-reports', 'report-exports'],
    'report/datatables/inventory_datatable.py:60': ['inventory-workbooks', 'report-exports'],
    'report/datatables/return_orders_datatable.py:63': ['operational-reports', 'report-exports'],
    'report/datatables/return_orders_datatable.py:328': ['operational-reports', 'report-exports'],
    'report/datatables/sales_data.py:66': ['operational-reports', 'report-exports'],
    'report/tasks.py:25': ['inventory-workbooks'], 'report/tasks.py:87': ['inventory-workbooks'],
    'report/tasks.py:134': ['inventory-workbooks'], 'report/tasks.py:139': ['inventory-workbooks'],
    'report/tasks.py:164': ['inventory-workbooks'], 'stores/tasks.py:11': ['source-diagnostic-task'],
}


def template_families(path):
    local = path.split('/templates/', 1)[1]
    if path.startswith('users/templates/admin/'):
        return ['shared-shell']
    if local == '500.html' or local == 'order/basic_error.html': return ['system-health']
    if local.startswith('auth/'):
        return ['identity'] if local.endswith('login.html') else ['self-profile'] if local.endswith('profile.html') else ['device-signin'] if local.endswith('auth_qr.html') else ['operators']
    if local == 'dashboard/dashboard.html': return ['dashboard-summary']
    if local == 'dashboard/main_dashboard.html': return ['shared-shell','motivational-quotes']
    if local.startswith('catalogue/'): return ['catalog-read']
    if local.startswith('delivery_timing/'): return ['support']
    if local.startswith('documentation/'): return ['documentation']
    if local.startswith('ecom_delivery/'): return ['support', 'ecommerce-inventory-sync']
    if local.startswith('edc_edit/'): return ['terminals']
    if local.startswith('gift_card/'): return ['gift-card-batches']
    if local.startswith('mpos_download/'): return ['staff-installer-handoff']
    if local.startswith('user_to_app/'): return ['customer-application-handoff']
    if local.startswith('offline_billing/'): return ['offline-scratch-invoice']
    if local.startswith(('order_punch/', 'shopify_order_punch/')): return ['legacy-order-imports']
    if local.startswith('upload_logs/'): return ['inventory-imports', 'legacy-order-imports', 'parent-store-assignment-csv', 'inactive-upload-logs']
    if local.startswith('salespersons/'): return ['salespeople']
    if local.startswith('special_permission/'): return ['special-permission-history', 'wallet-adjustments', 'global-vouchers', 'global-barcode-assignment']
    if local.startswith('settings/'): return ['support']
    if local == 'products/stock/inventory-sync.html': return ['catalog-maintenance']
    if local == 'products/stock/index.html' or local == 'products/stock/index_bak.html': return ['catalog-read', 'inventory', 'inventory-imports']
    if local.startswith(('products/hold_stock/', 'products/storage_stock/')) or local == 'products/inventory_logs.html': return ['inventory-audit']
    if local.startswith('products/store/'): return ['catalog-read','parent-store-assignment-csv']
    if local == 'products/index.html': return ['catalog-read']
    if local == 'order/create_order.html': return ['checkout-cart', 'customer-workspace', 'customer-contacts', 'customer-verification', 'payments', 'fast-cash', 'cashier-shortcuts', 'order-to-cart-copy', 'customer-website-handoff','motivational-quotes']
    if local == 'order/tab.html': return ['checkout-cart','motivational-quotes']
    if local == 'order/shortcuts.html': return ['cashier-shortcuts']
    if local == 'order/_exchange_js.html': return ['returns-exchanges']
    if local == 'order/_hl_banner.html': return ['express-fulfillment', 'notifications']
    if local == 'order/add_order_feedback.html': return ['product-feedback']
    if local == 'order/shipping.html': return ['shipping-labels']
    if local == 'order/invoice.html': return ['invoice-documents']
    if local.startswith('order/hyperlocal/'): return ['express-fulfillment']
    if local.startswith('order/online/'): return ['orders-read', 'returns-exchanges', 'invoice-documents']
    if local in ['order/index.html', 'order/show.html']: return ['orders-read', 'payments', 'returns-exchanges', 'pending-order-cancellation', 'local-deliveries'] + (['legacy-vinculum-status'] if local=='order/show.html' else [])
    if local.startswith('bd_report/'): return ['business-metrics-upload']
    if local.startswith('daily_store_report/'): return ['daily-store-report']
    if local.startswith('day_close/'): return ['finance-day-close']
    if local.startswith('export/'): return ['report-exports']
    if local.startswith(('orders/', 'performance_report/', 'sales/')): return ['operational-reports']
    if local.startswith('product/'): return ['inventory-workbooks', 'catalog-read']
    if local.startswith('counters/'): return ['counters']
    if local == 'stores/slack_callback.html': return ['store-slack-oauth']
    if local.startswith('stores/storage/'): return ['storage']
    if local.startswith('stores/'): return ['stores', 'store-images', 'location-codes', 'country-search']
    raise ValueError(f'Unmapped template: {path}')


def source_definition(route):
    tree = ast.parse(pinned(route['file']))
    calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call) and node.lineno == route['line'] and isinstance(node.func, ast.Name) and node.func.id in ['path', 're_path']]
    if not calls:
        return None
    view = calls[0].args[1]
    while isinstance(view, ast.Call) and isinstance(view.func, ast.Name) and view.func.id in ['sync_to_async', 'async_to_sync']:
        view = view.args[0]
    if isinstance(view, ast.Call) and isinstance(view.func, ast.Attribute) and view.func.attr in ['as_view', 'as_asgi']:
        view = view.func.value
    parts = ast.unparse(view).split('.')
    imports = {}
    for node in tree.body:
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                imports[alias.asname or alias.name] = ((node.module + '.') if node.module else '') + alias.name
        elif isinstance(node, ast.Import):
            for alias in node.names: imports[alias.asname or alias.name] = alias.name
    absolute = imports.get(parts[0], parts[0]) + ('.' + '.'.join(parts[1:]) if len(parts) > 1 else '')
    name = parts[-1]
    module = absolute.rsplit('.', 1)[0].replace('.', '/') + '.py'
    if module not in {item['path'] for item in inventory['source_hashes']}:
        return {'symbol': name, 'import': absolute, 'framework': True}
    for node in ast.parse(pinned(module)).body:
        if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            segment = '\n'.join(pinned(module).splitlines()[node.lineno - 1:node.end_lineno])
            templates = sorted(set(value.value for value in ast.walk(node) if isinstance(value, ast.Constant) and isinstance(value.value, str) and value.value.endswith('.html')))
            return {'symbol': name, 'file': module, 'line': node.lineno, 'end_line': node.end_lineno, 'sha256': sha(segment.encode()), 'templates': templates}
    return {'symbol': name, 'import': absolute, 'definition_unresolved': True}


def surface_status(keys):
    # This retained template has only commented routes/classes. Shared task-family
    # associations preserve lineage; they do not make the inactive page partial.
    if 'inactive-upload-logs' in keys:
        return 'missing'
    states = [families[key]['implementation_status'] for key in keys]
    if all(state == 'missing' for state in states): return 'missing'
    if any(state in ['partial', 'missing'] for state in states): return 'partial'
    if any(families[key]['external_acceptance'] for key in keys): return 'external_acceptance'
    return 'implementation_present'


def mapped(source, keys):
    if not keys or any(key not in families for key in keys):
        raise ValueError(f'Surface lacks an explicit mapped family: {source["id"]}: {keys}')
    return {'source': source, 'families': list(dict.fromkeys(keys)), 'status': surface_status(keys),
            'workflow_certified': False, 'inventory_status_unchanged': source.get('status', 'unverified')}


def build():
    define_families()
    family('order-messages', ['src/modules/checkout/order-messages'], ['src/pages/checkout/CheckoutReview.tsx'],
           ['tests/checkout'], ['parity/order-messages.md'], scope='Durable original order-created SMS/NPS preference, local source text and purpose-only link/transport without legacy customer tokens.',
           external=['Accept purpose-specific receiver/provider templates and signed acknowledgement before sending.'])
    bind('order-messages', ['AjaxOrderView'])
    bind('model-administration-access', ['admin.site.urls'])
    output = {key: [] for key in EXPECTED}
    mounts = defaultdict(list)
    for route in inventory['routes']:
        if route['include']:
            mounts[route['include'].replace('.', '/') + '.py'].append(route['route'])
    for route in inventory['routes']:
        if route['include']: continue
        row = mapped(route, route_groups[route['id']])
        row['source_definition'] = source_definition(route)
        row['effective_paths'] = ['/' + prefix + route['route'] for prefix in mounts.get(route['file'], [''])]
        output['routes'].append(row)
    for job in inventory['jobs']:
        row = mapped(job, JOB_FAMILIES[job['id']])
        node = next((node for node in ast.walk(ast.parse(pinned(job['file']))) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.lineno == job['line']), None)
        if not node: raise ValueError(f'Source job definition not found: {job["id"]}')
        row['source_definition'] = {'file': job['file'], 'line': node.lineno, 'end_line': node.end_lineno, 'symbol': job['name']}
        row['reachability'] = 'latent-commented-http-caller' if job['id'] in ['core/tasks.py:51','core/tasks.py:62','order/views.py:3839','report/datatables/inventory_datatable.py:60'] or job['file']=='report/tasks.py' else 'registered-task-or-caller'
        if job['id'] == 'stores/tasks.py:11': row['reachability'] = 'diagnostic-only-no-account-write'
        output['jobs'].append(row)
    referenced_templates = set()
    for route in output['routes']:
        referenced_templates.update((route['source_definition'] or {}).get('templates', []))
    for template in inventory['templates']:
        row = mapped(template, template_families(template['path']))
        local = template['path'].split('/templates/',1)[1]
        row['reachability'] = 'referenced-by-active-view' if local in referenced_templates else 'shared-include-or-latent-template'
        row['source_template_sha256'] = sha(pinned(template['path']).encode())
        row['original_template_flow_certified'] = False
        output['templates'].append(row)
    for socket in inventory['websockets']:
        output['websockets'].append(mapped(socket, ['notifications']))
    for admin in inventory['administration']:
        keys = ['stores','store-images','support','ecommerce-inventory-sync','inherited-administration-history','inherited-model-add-forms'] if admin['file']=='stores/admin.py' else ['operators','operator-administrative-profile','operator-mfa','model-administration-access','inherited-administration-history','inherited-model-add-forms']
        row = mapped(admin, keys)
        row['source_framework_capabilities'] = ['add/change/list/search/history', 'source model permissions', 'default selected-object action collector']
        row['lifecycle_clarification'] = 'User clarified Store/PosUser use reversible archive/deleted flags, not physical deletion. IDs/history/offline collected cash recognition must survive; generic hard delete is not a required active business flow.'
        row['compatibility_limits'] = ['Inherited username/password-only add is implemented separately with actual form defaults/blank-email uniqueness evidence. Actual Store.save always overwrites submitted url_key with the generated URL. Source nullable Store/physical NOT NULL conflicts remain diagnosed failures, and operational grants/actor lineage/full workflows are not certified.']
        output['administration'].append(row)
    for key, item in families.items():
        if 'implementation_review' in item:
            item['reviewed_source_surfaces'] = [
                {'kind': kind, 'id': row['source']['id'], 'disposition': row['status']}
                for kind, rows in output.items() for row in rows if key in row['families']
            ]
    actual = {key: len(value) for key, value in output.items()}
    if actual != EXPECTED: raise ValueError(f'Coverage mismatch: {actual} != {EXPECTED}')
    for key, rows in output.items():
        ids = [row['source']['id'] for row in rows]
        if len(ids) != len(set(ids)): raise ValueError(f'Duplicate source IDs: {key}')
    for item in families.values():
        item['test_files'] = sorted({name for ref in item['tests'] for name in ([ref] if (WORKSPACE/ref).is_file() else [str(path.relative_to(WORKSPACE)) for path in (WORKSPACE/ref).rglob('*') if path.is_file() and path.name.endswith(('.test.ts','.spec.ts'))])})
    input_hashes['backend/parity/legacy-inventory.json'] = sha(INVENTORY.read_bytes())
    input_hashes['backend/parity/administration-feature-map.json'] = sha(ADMIN_MAP.read_bytes())
    for path, digest in input_hashes.items():
        if sha((WORKSPACE/path).read_bytes()) != digest: raise ValueError(f'Input changed during coverage pass: {path}')
    gaps = [{'family': key, 'state': value['implementation_status'], 'tasks': value['remaining_code']} for key,value in families.items() if value['remaining_code'] and value['code_task_required']]
    summary = {'surfaces': actual, 'total': sum(actual.values()), 'by_status': dict(Counter(row['status'] for rows in output.values() for row in rows)), 'by_kind': {key: dict(Counter(row['status'] for row in rows)) for key,rows in output.items()}, 'families':len(families), 'code_task_groups':len(gaps), 'workflow_certifications_added':0, 'unmapped':0}
    return {'schema_version':1, 'source_commit':PIN, 'meaning':'Implementation map only. Existing release-coverage statuses remain unchanged. Test file presence/component checks never imply source workflow or production certification. Known defects and inactive policy candidates retain their separate decision records, including the pending wallet calendar-date decision; zero feature gap groups does not activate those candidates or pass their gates.', 'status_definitions':{'implementation_present':'Mapped behavior is implemented at component/code level; no full source workflow certification.', 'partial':'An identified source behavior or binding is incomplete; see family remaining_code.', 'missing':'No matching implementation of this behavior was established; adjacent features do not substitute.', 'external_acceptance':'Implementation is present but a named real provider/data/publication/shared-writer acceptance remains.'}, 'summary':summary, 'input_sha256':dict(sorted(input_hashes.items())), 'families':list(families.values()), 'remaining_code_tasks':gaps, **output}


def markdown(result):
    counts = result['summary']
    lines = ['# Exact source-surface implementation map', '', f"Baseline `{PIN}`. **{counts['total']} surfaces mapped; zero unmapped; zero release certifications added.**", '', 'This is the implementation inventory requested for the full rewrite, not a replacement for `release-coverage.json`. Existing component/source/native/browser tests remain bounded evidence. No original-template or complete production workflow is certified by this file.', '', '| Source kind | Count |', '| --- | ---: |']
    lines += [f'| {key} | {value} |' for key,value in counts['surfaces'].items()]
    lines += ['', 'The 263 route declarations contain eight include mounts; all 255 leaves remain individually mapped, including aliases/duplicates and the framework-admin mount. Order routes retain both `/api/v1/orders/` and `/orders/` mount paths. All 32 named tasks and all 106 templates remain visible, including latent/commented callers and diagnostics.', '', '## Concrete remaining code, by feature group', '']
    if not result['remaining_code_tasks']:
        lines.append('No additional missing source-feature implementation is currently identified by this map. The named external acceptance gates, default-disabled selections and explicit inactive/diagnostic exclusions remain. Known defects and inactive policy candidates retain their separate decision records; the wallet calendar-date decision in `compatibility/upstream/other-writer-origins/go/expiry-review/parity-decision.md` remains pending. No release, default-gate or full-workflow certification is added.')
    for gap in result['remaining_code_tasks']:
        lines.append(f"- **{gap['family']} ({gap['state']})**: " + ' '.join(gap['tasks']))
    lines += ['', '## Line-bound implementation review', '', 'These reviewed code paths bind actual import/manager/table controls and preserve the explicitly excluded source diagnostics/prototype and inactive upload-log/download. Line anchors are regenerated from current implementation or pinned source; test presence does not establish these claims.', '']
    for item in result['families']:
        if not item.get('implementation_review'):
            continue
        lines += [f"### {item['id']}", '', 'Mapped surfaces: ' + ', '.join('`' + row['id'] + '` (' + row['disposition'] + ')' for row in item['reviewed_source_surfaces']) + '.', '', '| Code/source reference | Reviewed scope |', '| --- | --- |']
        for ref in item['implementation_review']:
            lines.append(f"| `{ref['path']}:{ref['line']}` | {ref['scope']} |")
        lines.append('')
    lines += ['', 'Any remaining code gaps are distinct from configured provider acceptance. Parent/store archive/reactivation retains stable financial identities per the user clarification; generic physical Store/PosUser deletion is not a missing active feature. `create_random_user_accounts_new` only prints generated credentials with its actual account insert commented out: its missing replacement is a diagnostic-only inventory item, not a newly required credential-logging or mass-account product feature.', '', '## Implementation/acceptance counts', '', '| Kind | Present | Partial | Missing | External acceptance |', '| --- | ---: | ---: | ---: | ---: |']
    for kind, values in counts['by_kind'].items(): lines.append('| ' + kind + ' | ' + ' | '.join(str(values.get(state,0)) for state in ['implementation_present','partial','missing','external_acceptance']) + ' |')
    lines += ['', '“External acceptance” means code exists and the named real dependency remains unaccepted. It does not turn a missing callback/financial adapter into a deployed feature. Warehouse absence, source collation/generation proofs, shared writer patches, physical printers, real OAuth/SMS/mail and SDD/legal rendering are carried at their specific family boundaries in the JSON; they are not hundreds of invented code tasks.', '', '## Source-to-replacement ledger', '', 'Each row below links to family IDs in `source-surface-map.json`; those families list current backend/frontend modules, test files/directories, source evidence and exact code/external gaps. Original IDs and unverified status are retained unchanged. A mapped template means the corresponding React feature is accounted for, not that every original DOM transition has been certified.', '']
    for kind in EXPECTED:
        lines += [f'### {kind}', '', '| Source | Surface | Families | Implementation disposition |', '| --- | --- | --- | --- |']
        for row in result[kind]:
            source=row['source']; label=source.get('route') or source.get('path') or source.get('name') or ', '.join(source.get('models',[])) or '(root)'
            label=str(label).replace('|','&#124;')
            lines.append(f"| `{source['id']}` | `{label}` | {', '.join(row['families'])} | {row['status']} |")
        lines.append('')
    lines += ['## Reproducibility and limits', '', 'Regenerate with `python3 tools/parity/build_source_surface_map.py`; validate saved outputs without writing using `--check`. The generator verifies pinned source hashes, exact source ID/count coverage, explicit family membership, evidence-path existence and stable file inputs during generation. It only writes the two new map artifacts. It does not run tests, builds, servers, providers, DDL or source jobs and never modifies application code, source siblings or the release coverage ledger.', '', 'Source definitions/rendered templates are resolved from pinned Python AST/imports where possible. Framework/dynamic imports remain labeled explicitly. Test references identify evidence scope; they are not fresh test receipts. Implementation hashes capture this review snapshot while other agents may continue their separately owned work; regenerate after those slices land.']
    return '\n'.join(lines)+'\n'


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--check',action='store_true');args=parser.parse_args()
    result=build();outputs={BACKEND/'parity/source-surface-map.json':json.dumps(result,indent=2)+'\n',BACKEND/'parity/source-surface-map.md':markdown(result)}
    for path,text in outputs.items():
        if args.check:
            if not path.exists() or path.read_text()!=text: raise ValueError(f'Source-surface map is stale: {path.name}')
        else:path.write_text(text)
    print(f"Mapped {result['summary']['total']} source surfaces; remaining code groups={result['summary']['code_task_groups']}; unmapped=0; release certifications added=0")


if __name__=='__main__':main()
