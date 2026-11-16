import { bigint, datetime, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
/** Read-only candidate and bound operational status/age mapping; physical metadata verified. */
export const scheduledCrmLog = mysqlTable('hyperlocal_fd_logs', {
  id: bigint('id', { mode: 'bigint' }).primaryKey(),
  orderId: bigint('order_id', { mode: 'bigint' }),
  ticketId: varchar('fd_ticket_id', { length: 55 }),
  status: varchar('fd_ticket_status', { length: 64 }),
  age: varchar('fd_ticket_age', { length: 45 }),
  createdAt: datetime('created_at', { mode: 'string' }),
});
