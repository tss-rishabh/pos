import { expect, it } from 'vitest';
import { orderLink, orderLinkState } from '../src/pages/checkout/order-link';
const scope = { operatorId: '44', storeId: '1' },
  query = new URLSearchParams('orderId=9007199254740993');
it('binds an exact deep link to the first operator/store without changing its integer representation', () => {
  expect(orderLink(query, null, scope)).toMatchObject({
    id: '9007199254740993',
    needsBinding: true,
  });
  const state = orderLinkState({ retained: 'value' }, scope);
  expect(state.retained).toBe('value');
  expect(orderLink(query, state, scope)).toEqual({
    id: '9007199254740993',
    invalid: false,
    needsBinding: false,
    mismatch: false,
  });
});
it('clears selection on store or operator changes, including a remount with the old history entry', () => {
  const state = orderLinkState(null, scope);
  expect(orderLink(query, state, { ...scope, storeId: '2' })).toMatchObject({
    id: '',
    mismatch: true,
  });
  expect(orderLink(query, state, { ...scope, operatorId: '45' })).toMatchObject({
    id: '',
    mismatch: true,
  });
  expect(orderLinkState(state, null)).not.toHaveProperty('orderSelection');
});
it.each([
  'orderId=01',
  'orderId=1&orderId=2',
  'orderId=9223372036854775808',
  'orderId=../other',
  'orderId=1e3',
])('rejects untrusted URL references before any detail read: %s', (value) => {
  expect(orderLink(new URLSearchParams(value), null, scope)).toMatchObject({
    id: '',
    invalid: true,
    needsBinding: false,
  });
});
