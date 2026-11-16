export interface HistoryFixture {
  name: string;
  sourceNow: string;
  orders: {
    id: string;
    user_id: string;
    order_amt: number;
    created_at: string;
    order_status: number;
  }[];
  order_stores: { id: string; order_id: string }[];
  has_products: {
    id: string;
    order_id: string;
    prod_id: string;
    sub_prod_id: string;
    qty: number;
    price: number;
  }[];
  products: { id: string; parent_prod_id: string; product: string; price: number }[];
  nps_feedback: { id: number; order_id: string; feedback_answer: string }[];
}
const base = 9007199254740993n,
  id = (offset: number) => (base + BigInt(offset)).toString(),
  hp = (offset: number) => (base + 1000n + BigInt(offset)).toString();
export function customerHistoryFixtures(): HistoryFixture[] {
  const normal: HistoryFixture = {
    name: 'source-multiplicity',
    sourceNow: '2026-11-16 10:00:00',
    orders: [
      {
        id: id(0),
        user_id: '7',
        order_amt: 400,
        created_at: '2026-11-16 10:00:00',
        order_status: 3,
      },
      {
        id: id(1),
        user_id: '7',
        order_amt: 210,
        created_at: '2026-11-15 10:00:00',
        order_status: 4,
      },
      {
        id: id(2),
        user_id: '7',
        order_amt: 150,
        created_at: '2026-11-14 10:00:00',
        order_status: 6,
      },
      { id: id(3), user_id: '7', order_amt: 0, created_at: '2026-11-13 10:00:00', order_status: 0 },
      {
        id: id(4),
        user_id: '7',
        order_amt: 0,
        created_at: '2026-11-12 10:00:00',
        order_status: 17,
      },
      {
        id: id(5),
        user_id: '7',
        order_amt: 50,
        created_at: '2026-10-17 10:00:00',
        order_status: 7,
      },
      {
        id: id(6),
        user_id: '7',
        order_amt: 50,
        created_at: '2026-10-17 10:00:01',
        order_status: 22,
      },
      {
        id: id(7),
        user_id: '7',
        order_amt: 50,
        created_at: '2026-10-16 10:00:00',
        order_status: 10,
      },
      {
        id: id(8),
        user_id: '99',
        order_amt: 99999,
        created_at: '2026-11-17 10:00:00',
        order_status: 3,
      },
    ],
    order_stores: [
      { id: '1', order_id: id(1) },
      { id: '2', order_id: id(1) },
      { id: '3', order_id: id(2) },
      { id: '4', order_id: id(8) },
    ],
    has_products: [
      { id: hp(0), order_id: id(0), prod_id: '11', sub_prod_id: '0', qty: 2, price: 150 },
      { id: hp(1), order_id: id(0), prod_id: '13', sub_prod_id: '12', qty: 1, price: 90 },
      { id: hp(2), order_id: id(0), prod_id: '999', sub_prod_id: '0', qty: 1, price: 1 },
      { id: hp(3), order_id: id(2), prod_id: '11', sub_prod_id: '0', qty: 1, price: 100 },
      { id: hp(4), order_id: id(2), prod_id: '11', sub_prod_id: '0', qty: 2, price: 190 },
      { id: hp(5), order_id: id(2), prod_id: '13', sub_prod_id: '0', qty: 1, price: 3 },
      { id: hp(6), order_id: id(8), prod_id: '10', sub_prod_id: '0', qty: 9, price: 0 },
    ],
    products: [
      { id: '10', parent_prod_id: '0', product: 'Fixture parent', price: 100 },
      { id: '11', parent_prod_id: '10', product: 'Fixture child', price: 90 },
      { id: '12', parent_prod_id: '10', product: 'Fixture effective child', price: 80 },
      { id: '13', parent_prod_id: '0', product: 'Fixture standalone', price: 3.5 },
    ],
    nps_feedback: [
      { id: 1, order_id: id(3), feedback_answer: ' 9abc' },
      { id: 2, order_id: id(1), feedback_answer: '4foo' },
      { id: 3, order_id: id(2), feedback_answer: '' },
      { id: 4, order_id: id(0), feedback_answer: '.5e1x' },
      { id: 5, order_id: id(0), feedback_answer: 'bad' },
      { id: 6, order_id: id(0), feedback_answer: '1e' },
      { id: 7, order_id: id(8), feedback_answer: '99999' },
    ],
  };
  const upper = structuredClone(normal);
  upper.name = 'approximate-half-even-up';
  upper.has_products.find((row) => row.id === hp(5))!.price = 2;
  const empty: HistoryFixture = {
    name: 'empty-customer',
    sourceNow: normal.sourceNow,
    orders: [],
    order_stores: [],
    has_products: [],
    products: [],
    nps_feedback: [],
  };
  const pagination = structuredClone(empty);
  pagination.name = 'return-pagination-and-same-day-ties';
  pagination.products = [normal.products[1]!, normal.products[0]!];
  for (let index = 0; index < 8; index++) {
    const orderId = id(20 + index);
    pagination.orders.push({
      id: orderId,
      user_id: '7',
      order_amt: index,
      created_at: '2026-11-16 10:00:00',
      order_status: 6,
    });
    for (let line = 0; line < 23; line++)
      pagination.has_products.push({
        id: hp(index * 30 + line),
        order_id: orderId,
        prod_id: '11',
        sub_prod_id: '0',
        qty: 1,
        price: 100,
      });
  }
  const prefixes = structuredClone(normal);
  prefixes.name = 'mysql-numeric-prefix';
  prefixes.nps_feedback = [
    '\t +.25x',
    '-2e+1 tail',
    '0xFF',
    'Infinity',
    'NaN',
    '  ',
    '1.2.3',
    '1e+',
    ' 4',
    '3E-1tail',
    '+.5',
    '-.5',
  ].map((feedback_answer, index) => ({ id: index + 1, order_id: id(0), feedback_answer }));
  return [normal, upper, empty, pagination, prefixes];
}
