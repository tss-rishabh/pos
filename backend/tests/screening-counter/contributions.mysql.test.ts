import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type mysql from 'mysql2/promise';
import type { AdministrationTransaction } from '../../src/modules/administration/checkins.js';
import {
  financialTransaction,
  lockScreeningCustomer,
} from '../../src/modules/legacy-order-imports/screening-transactions.js';
import { readCurrentScreeningCounter } from '../../src/modules/legacy-order-imports/screening-counter/reader.js';
import { screeningCounterMutation } from '../../src/modules/legacy-order-imports/screening-counter/entry.js';
import { currentCounterFixture, counterOptions, insertCounterFixture } from './fixture.js';
const template = process.env.CHECKOUT_MYSQL_TEST_URL;
describe.skipIf(!template)('screening contribution join keys and concurrent native writers', () => {
  let f: Awaited<ReturnType<typeof currentCounterFixture>>;
  beforeAll(async () => {
    f = await currentCounterFixture(template!);
    await f.initialize('77');
    await f.initialize('78');
  }, 30000);
  afterAll(async () => {
    await f?.close();
  });
  const parents = {
    customerIds: ['77', '78'],
    orderIds: ['100', '101', '102', '200', '201', '202'],
    lineIds: ['300', '301', '302', '400', '401', '402'],
  };
  const mutate = (work: (tx: AdministrationTransaction) => Promise<void>) =>
    screeningCounterMutation(f.db, parents, work);
  async function equal() {
    for (const customer of ['77', '78']) {
      const [raw] = await f.connection.query<mysql.RowDataPacket[]>(
        'SELECT CAST(COUNT(*) AS CHAR) bought FROM spiderman_screening_orders s JOIN orders o ON o.id=s.order_id JOIN has_products hp ON hp.id=s.has_product_id WHERE s.user_id=? AND hp.prod_id=390238 AND o.order_status NOT IN(0,17)',
        [customer],
      );
      const current = await financialTransaction(f.db, true, async (tx) => {
        await lockScreeningCustomer(tx, customer);
        return readCurrentScreeningCounter(tx, customer, counterOptions);
      });
      expect(String(current.count)).toBe(raw[0]!.bought);
    }
  }
  async function change(statement: ReturnType<typeof sql>) {
    await mutate(async (tx) => {
      await tx.execute(statement);
    });
    await equal();
  }
  it('matches every literal join-key mutation, duplicate, orphan and status including NULL', async () => {
    await mutate(async (tx) => {
      await insertCounterFixture(tx, 'orders', { id: '100', user_id: '77', order_status: 1 });
      await insertCounterFixture(tx, 'has_products', {
        id: '300',
        order_id: '100',
        prod_id: '390238',
        qty: 2,
      });
      await tx.execute(
        sql`INSERT INTO spiderman_screening_orders(id,order_id,has_product_id,user_id) VALUES(1,100,300,77),(2,100,300,77)`,
      );
    });
    await equal();
    // Multiplicity is marker rows, never HP quantity, order customer or HP.order_id.
    await change(sql`UPDATE has_products SET qty=12,order_id=999 WHERE id=300`);
    await change(sql`UPDATE orders SET user_id=78 WHERE id=100`);
    for (const status of [0, 17, null, 4, 3, 1])
      await change(sql`UPDATE orders SET order_status=${status} WHERE id=100`);
    await change(sql`UPDATE has_products SET prod_id=123 WHERE id=300`);
    await change(sql`UPDATE has_products SET prod_id=390238 WHERE id=300`);
    await change(sql`UPDATE spiderman_screening_orders SET user_id=78 WHERE id=2`);
    await change(sql`UPDATE spiderman_screening_orders SET id=3 WHERE id=2`);
    await change(sql`UPDATE orders SET id=101 WHERE id=100`);
    await change(sql`UPDATE spiderman_screening_orders SET order_id=101 WHERE id IN(1,3)`);
    await change(sql`UPDATE has_products SET id=301 WHERE id=300`);
    await change(sql`UPDATE spiderman_screening_orders SET has_product_id=301 WHERE id IN(1,3)`);
    await change(sql`DELETE FROM orders WHERE id=101`);
    await mutate(async (tx) => {
      await insertCounterFixture(tx, 'orders', { id: '101', user_id: '78', order_status: 4 });
    });
    await equal();
    await change(sql`DELETE FROM has_products WHERE id=301`);
    await mutate(async (tx) => {
      await insertCounterFixture(tx, 'has_products', {
        id: '301',
        order_id: '101',
        prod_id: '390238',
        qty: 1,
      });
    });
    await equal();
    // A marker can predate BOTH joined parents. Each later insert updates it.
    await change(
      sql`INSERT INTO spiderman_screening_orders(id,order_id,has_product_id,user_id) VALUES(4,200,400,77)`,
    );
    await mutate(async (tx) => {
      await insertCounterFixture(tx, 'orders', { id: '200', user_id: '78', order_status: 1 });
    });
    await equal();
    await mutate(async (tx) => {
      await insertCounterFixture(tx, 'has_products', {
        id: '400',
        order_id: '200',
        prod_id: '390238',
        qty: 1,
      });
    });
    await equal();
    await change(
      sql`UPDATE spiderman_screening_orders SET order_id=102,has_product_id=302 WHERE id=4`,
    );
    await mutate(async (tx) => {
      await insertCounterFixture(tx, 'has_products', {
        id: '302',
        order_id: '102',
        prod_id: '390238',
        qty: 1,
      });
      await insertCounterFixture(tx, 'orders', { id: '102', user_id: '77', order_status: 1 });
    });
    await equal();
    await change(sql`DELETE FROM spiderman_screening_orders WHERE id IN(1,3,4)`);
  });
  it('rejects unentered child writes and rolls back native rows plus projection after late failure', async () => {
    await expect(
      f.connection.query(
        'INSERT INTO spiderman_screening_orders(id,order_id,has_product_id,user_id) VALUES(8,100,300,77)',
      ),
    ).rejects.toMatchObject({ sqlState: '45000' });
    await expect(
      mutate(async (tx) => {
        await tx.execute(
          sql`INSERT INTO spiderman_screening_orders(id,order_id,has_product_id,user_id) VALUES(9,100,300,77)`,
        );
        throw new Error('controlled late rollback');
      }),
    ).rejects.toThrow('controlled late rollback');
    const [rows] = await f.connection.query<mysql.RowDataPacket[]>(
      'SELECT id FROM spiderman_screening_orders WHERE id IN(8,9)',
    );
    expect(rows).toEqual([]);
    await equal();
  });
  it('allows two customers to reach separate native child writes before either commits', async () => {
    let release!: () => void, arrived!: () => void;
    const wait = new Promise<void>((resolve) => {
        release = resolve;
      }),
      both = new Promise<void>((resolve) => {
        arrived = resolve;
      });
    let count = 0;
    const job = (customerId: string, orderId: string, lineId: string, id: number) =>
      screeningCounterMutation(
        f.db,
        { customerIds: [customerId], orderIds: [orderId], lineIds: [lineId] },
        async (tx) => {
          await insertCounterFixture(tx, 'orders', {
            id: orderId,
            user_id: customerId,
            order_status: 1,
          });
          await insertCounterFixture(tx, 'has_products', {
            id: lineId,
            order_id: orderId,
            prod_id: '390238',
            qty: 1,
          });
          await tx.execute(
            sql`INSERT INTO spiderman_screening_orders(id,order_id,has_product_id,user_id) VALUES(${id},${BigInt(orderId)},${BigInt(lineId)},${BigInt(customerId)})`,
          );
          if (++count === 2) arrived();
          await wait;
        },
      );
    const first = job('77', '201', '401', 10),
      second = job('78', '202', '402', 11);
    const done = Promise.all([first, second]);
    try {
      await Promise.race([both, done]);
    } finally {
      release();
    }
    await done;
    await equal();
  });
});
