/**
 * Compatibility shim. The rewrite once required a patched API-v2 "customer context" contract
 * (`X-POS-Customer-*` headers and response proofs). Legacy calls unpatched API-v2 with only
 * `Content-Type` and `Authorization`, so the contract is gone and these checks always pass.
 * Kept only for `customer-insights` (not owned by W4) until its owner drops the import.
 */
export const customerContextContract = 'pos-customer-context-v1';
export interface CustomerContextConfiguration {
  customerContextContract?: string;
  customerContextKey?: string;
  hs256?: string;
  hs512?: string;
}
export function assertCustomerContextReady(_environment: CustomerContextConfiguration): void {}
export function customerContextConfigured(_environment: CustomerContextConfiguration): boolean {
  return true;
}
