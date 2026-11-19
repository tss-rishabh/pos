import { eq } from 'drizzle-orm';
import { MUser, Order } from '../db/legacy-schema.js';
import type { Databases } from '../db/pools.js';
import type { OutboundContacts, OutboundRecipientDirectory } from './allowlist.js';

/**
 * Contacts an API-v2 / mailr message could reach, read only while the allowlist is enabled:
 * - customer: `users.telephone`, `users.email`;
 * - order: the customer's `users.telephone` and `users.email`, plus `orders.phone_no`.
 * Read on the writer (the order was usually committed a moment ago), falling back to the primary
 * reader where no writer is configured. Values are compared by the guard and never logged.
 */
export function databaseRecipientDirectory(db: Databases): OutboundRecipientDirectory {
  function connection() {
    try {
      return db.get('writer');
    } catch {
      return db.get('primary');
    }
  }
  return {
    async customer(id): Promise<OutboundContacts | null> {
      const [row] = await connection()
        .select({ telephone: MUser.telephone, email: MUser.email })
        .from(MUser)
        .where(eq(MUser.id, BigInt(id)))
        .limit(1);
      return row ? { phones: [row.telephone], emails: [row.email] } : null;
    },
    async order(id): Promise<OutboundContacts | null> {
      const [row] = await connection()
        .select({ phone: Order.phone_no, telephone: MUser.telephone, email: MUser.email })
        .from(Order)
        .leftJoin(MUser, eq(MUser.id, Order.user))
        .where(eq(Order.id, BigInt(id)))
        .limit(1);
      if (!row) return null;
      return {
        phones: [row.phone, row.telephone ?? ''],
        emails: [row.email ?? ''],
      };
    },
  };
}
