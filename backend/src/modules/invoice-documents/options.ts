import { z } from 'zod';
import { invoiceEnvironment, type InvoiceEnvironment } from '../checkout/invoices.js';

export interface InvoiceDocumentOptions extends InvoiceEnvironment {
  globalOnlineContract?: string;
  onlineUrl?: string;
  sameDayUrl?: string;
  expressUrl?: string;
  scopedContract?: string;
  historyContract?: string;
  historyPublicationContract?: string;
  historyOrdersView?: string;
  historyCustomersView?: string;
  historyPublicationsView?: string;
  historyMaxLagSeconds?: number;
}
export function invoiceDocumentOptions(
  env: NodeJS.ProcessEnv = process.env,
): InvoiceDocumentOptions {
  const value = z
    .object({
      UPSTREAM_POS_GLOBAL_ONLINE_INVOICE_CONTRACT: z.string().optional(),
      TSS_SDD_INVOICE_URL: z.url().optional(),
      TSS_EXPRESS_INVOICE_URL: z.url().optional(),
      UPSTREAM_POS_SCOPED_INVOICE_CONTRACT: z.string().optional(),
      TSS_ONLINE_INVOICE_URL: z.url().optional(),
      UPSTREAM_POS_INVOICE_HISTORY_CONTRACT: z.string().optional(),
      INVOICE_HISTORY_PUBLICATION_CONTRACT: z.string().optional(),
      BQ_INVOICE_HISTORY_ORDERS_VIEW: z.string().optional(),
      BQ_INVOICE_HISTORY_CUSTOMERS_VIEW: z.string().optional(),
      BQ_INVOICE_HISTORY_PUBLICATIONS_VIEW: z.string().optional(),
      INVOICE_HISTORY_MAX_LAG_SECONDS: z.coerce.number().int().min(60).max(3600).optional(),
    })
    .parse(Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')));
  return {
    ...invoiceEnvironment(env),
    globalOnlineContract: value.UPSTREAM_POS_GLOBAL_ONLINE_INVOICE_CONTRACT,
    onlineUrl: value.TSS_ONLINE_INVOICE_URL,
    sameDayUrl: value.TSS_SDD_INVOICE_URL,
    expressUrl: value.TSS_EXPRESS_INVOICE_URL,
    scopedContract: value.UPSTREAM_POS_SCOPED_INVOICE_CONTRACT,
    historyContract: value.UPSTREAM_POS_INVOICE_HISTORY_CONTRACT,
    historyPublicationContract: value.INVOICE_HISTORY_PUBLICATION_CONTRACT,
    historyOrdersView: value.BQ_INVOICE_HISTORY_ORDERS_VIEW,
    historyCustomersView: value.BQ_INVOICE_HISTORY_CUSTOMERS_VIEW,
    historyPublicationsView: value.BQ_INVOICE_HISTORY_PUBLICATIONS_VIEW,
    historyMaxLagSeconds: value.INVOICE_HISTORY_MAX_LAG_SECONDS,
  };
}
