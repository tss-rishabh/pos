import { returnEligibilitySchema, type ReturnEligibility } from '../../src/pages/returns/client';
import { exchangeCell, type ExchangeCellFacts } from '../../src/pages/returns/exchange-cell';

/**
 * A server return-eligibility response for an eligible, delivered store line. The cell is
 * chosen by the same legacy template branch selector the server uses (exchange-cell.ts).
 */
export function eligibleLine(input: {
  orderId: string;
  lineId: string;
  kind: 'return' | 'exchange';
}): ReturnEligibility {
  const open = { status: true, reason: '', upto: '2026-12-31' };
  const facts: ExchangeCellFacts & { returnStatus: number; merged: boolean } = {
    variant: 'store',
    shopifyOrder: false,
    eligibilityLoaded: true,
    productType: 1,
    lineStatus: 'DELIVERED',
    return: open,
    exchange: open,
    superAdminReturnOverride: false,
    failedExchange: null,
    checkinStoreId: '1',
    exchangeFeatureEnabled: true,
    operatorRole: 4,
    returnStatus: 0,
    merged: false,
  };
  return returnEligibilitySchema.parse({
    ...input,
    allowed: true,
    until: open.upto,
    reason: '',
    overrideAvailable: false,
    exchangeFeatureEnabled: true,
    facts,
    cell: exchangeCell(facts),
  });
}
