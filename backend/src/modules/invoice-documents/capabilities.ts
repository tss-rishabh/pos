import type { Databases } from '../../db/pools.js';
import type { Principal } from '../../domain/access.js';
import {
  hasSourceSameDayInvoice,
  invoiceScopeSnapshot,
  invoiceScopeUnavailable,
  selectedExpressIds,
} from './authority.js';
import { fullInvoiceOwnership, type InvoiceDocumentScope } from './contracts.js';
import { feedbackProofContract, invoiceSecurityContract } from '../checkout/invoice-security.js';
import { invoiceHistoryContract } from './history-proof.js';
import { invoiceHistoryPublicationContract } from './history.js';
import type { InvoiceDocumentOptions } from './options.js';
import { globalOnlineInvoiceContract } from './global-proof.js';
import { scopedInvoiceContract } from './scope-proof.js';

export function invoiceCapabilities(db: Databases, options: InvoiceDocumentOptions) {
  const capture = invoiceScopeSnapshot(db);
  return async (user: Principal, scope: InvoiceDocumentScope) => {
    const snapshot = await capture(user, scope),
      full = Boolean(snapshot.globalOnline || fullInvoiceOwnership(snapshot.ownership)),
      express = !snapshot.globalOnline && selectedExpressIds(snapshot.ownership) !== null;
    if (!full && !express) throw invoiceScopeUnavailable();
    const base = Boolean(
        options.serviceKey &&
        options.securityContract === invoiceSecurityContract &&
        options.feedbackContract === feedbackProofContract,
      ),
      scoped = base && options.scopedContract === scopedInvoiceContract;
    const online =
      Boolean(snapshot.globalOnline) ||
      (full && snapshot.ownership.lines.some((line) => line.platformId !== '2'));
    const globalReady =
      !snapshot.globalOnline || options.globalOnlineContract === globalOnlineInvoiceContract;
    const history =
      options.historyContract === invoiceHistoryContract &&
      options.historyPublicationContract === invoiceHistoryPublicationContract &&
      Boolean(
        options.historyOrdersView &&
        options.historyCustomersView &&
        options.historyPublicationsView &&
        options.historyMaxLagSeconds,
      );
    return {
      ...(scope.access ? { access: scope.access } : {}),
      storeId: scope.storeId,
      orderId: scope.orderId,
      actions: [
        ...(online
          ? [
              {
                kind: 'online' as const,
                available: base && Boolean(options.onlineUrl) && history && globalReady,
              },
            ]
          : []),
        ...(full && hasSourceSameDayInvoice(snapshot.ownership)
          ? [
              {
                kind: 'same-day' as const,
                available:
                  scoped &&
                  Boolean(options.sameDayUrl) &&
                  globalReady &&
                  (!snapshot.globalOnline || history),
              },
            ]
          : []),
        ...(express
          ? [{ kind: 'express' as const, available: scoped && Boolean(options.expressUrl) }]
          : []),
      ],
    };
  };
}
