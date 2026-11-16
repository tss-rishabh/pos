import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { contactUsers } from '../../src/modules/customer-contacts/legacy-schema.js';
import {
  bumpCurrentContactRevision,
  customerContactRevisions,
  ensureCustomerContactRevision,
  readCurrentContactRevision,
} from '../../src/modules/customer-contacts/revisions.js';
import { customerContactFixture } from './mysql-fixture.js';

const template = process.env.CUSTOMER_CONTACT_MYSQL_TEST_URL;
describe.skipIf(!template)('monotonic contact authority on isolated MySQL', () => {
  let native: Awaited<ReturnType<typeof customerContactFixture>>;
  beforeAll(async () => {
    native = await customerContactFixture(template!, ['users']);
  });
  beforeEach(async () => {
    await native.db.get('writer').delete(customerContactRevisions);
    await native.db.get('writer').delete(contactUsers);
    await native.fixture.insert('users', {
      id: '7',
      email: 'contact.fixture@example.test',
      telephone: '9876543210',
      user_type: '2',
      status: 1,
    });
  });
  afterAll(async () => {
    await native?.close();
  });
  async function lockCustomer(tx: Parameters<typeof readCurrentContactRevision>[0]) {
    await tx
      .select({ id: contactUsers.id })
      .from(contactUsers)
      .where(eq(contactUsers.id, 7n))
      .for('update');
  }
  it('starts untouched accounts at zero and retains exact bigint revisions beyond 2^53', async () => {
    await native.db.get('writer').transaction(async (tx) => {
      await lockCustomer(tx);
      expect(await readCurrentContactRevision(tx, '7')).toBe(0n);
      expect(await ensureCustomerContactRevision(tx, '7')).toBe(0n);
      expect(await ensureCustomerContactRevision(tx, '7')).toBe(0n);
      await tx
        .update(customerContactRevisions)
        .set({ revision: 9007199254740993n })
        .where(eq(customerContactRevisions.customerId, '7'));
      expect(await bumpCurrentContactRevision(tx, '7')).toBe(9007199254740994n);
    });
  });
  it('reads the latest committed revision even after an older repeatable-read snapshot', async () => {
    await native.db.get('writer').transaction(async (tx) => {
      await lockCustomer(tx);
      await ensureCustomerContactRevision(tx, '7');
    });
    await native.db.get('writer').transaction(async (reader) => {
      const [snapshot] = await reader.select().from(customerContactRevisions);
      expect(snapshot?.revision).toBe(0n);
      await native.db.get('writer').transaction(async (writer) => {
        await lockCustomer(writer);
        expect(await bumpCurrentContactRevision(writer, '7')).toBe(1n);
      });
      await lockCustomer(reader);
      expect(await readCurrentContactRevision(reader, '7')).toBe(1n);
    });
  });
});
