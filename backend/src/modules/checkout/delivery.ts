export type DeliveryOutcome = 'delivered' | 'rejected' | 'uncertain' | 'blocked';
export interface DeliveryResult {
  id: string;
  resource:
    | 'order-kinesis'
    | 'order-engagement'
    | 'order-sms'
    | 'return-email'
    | 'exchange-email'
    | 'discount-approval-email'
    | 'discount-used-email'
    | 'customer-registration-sms'
    | 'customer-registration-whatsapp';
  outcome: DeliveryOutcome;
  requestId: string | null;
  operatorId: string | null;
}
export type DeliveryObserver = (result: DeliveryResult) => void;
