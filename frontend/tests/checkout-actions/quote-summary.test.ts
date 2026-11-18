import { expect,it } from 'vitest';
import { calculationAmounts,quoteAmount,quoteIsCurrent } from '../../src/pages/checkout/quote-summary';
import { checkoutCartLines } from '../../src/pages/checkout/CheckoutCartLines';
import { quotedCheckout } from './quote-fixture';
it('formats supplied decimal strings exactly without rounding or recomputing totals',()=>{
  expect(quoteAmount('9007199254740993.01')).toBe('9,007,199,254,740,993.01');
  expect(quoteAmount('25.490000000000001')).toBe('25.490000000000001');
  expect(quoteAmount('-0.49')).toBe('-0.49');expect(quoteAmount(0)).toBe('0.00');
  for(const value of [undefined,null,'',NaN,Infinity,'1e3',{},'not-an-amount']) expect(quoteAmount(value)).toBeNull();
});
it('requires one actual calculations row and never invents missing zero fields',()=>{
  const checkout=quotedCheckout();expect(calculationAmounts(checkout.quote)?.total).toBe('868.00');
  expect(calculationAmounts({meta:{items:[]}})).toBeNull();
  expect(calculationAmounts({meta:{items:[{name:'calculations',total:'1'},{name:'calculations',total:'2'}]}})).toBeNull();
  expect(quoteAmount(calculationAmounts({meta:{items:[{name:'calculations',total:'1'}]}})?.gst_total)).toBeNull();
});
it('requires complete matching current operator/store/counter/draft/version and no pending quote mutation',()=>{
  const checkout=quotedCheckout(),draft={id:checkout.draftId!,updatedAt:1,ownerId:'1',storeId:'2',counterId:'3'};
  expect(quoteIsCurrent(checkout,draft,true)).toBe(true);
  for(const changed of [{...checkout,phase:'open' as const},{...checkout,operatorId:'other'},{...checkout,storeId:'other'},{...checkout,counterId:'other'},{...checkout,draftVersion:2},{...checkout,busyOperationId:'pending'}]) expect(quoteIsCurrent(changed,draft,true)).toBe(false);
  expect(quoteIsCurrent(checkout,draft,false)).toBe(false);
});
it('preserves provider ordinary/complementary line IDs, prices and readonly quantities',()=>{
  const lines=checkoutCartLines(quotedCheckout().cart);expect(lines?.products[0]?.prod_id).toBe('9007199254740993');
  expect(lines?.products[0]?.spl_price).toBe('450.25');expect(lines?.complementary[0]?.quantity).toBe(1);
  expect(checkoutCartLines({products:{items:[{prod_id:9007199254740992,product:'Unsafe identifier',quantity:1,price:1}]}})).toBeNull();
});
