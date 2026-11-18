import { bigint, datetime, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
/** Read-only mapping of external source tables; never migrate these tables. */
export const NpsFeedback = mysqlTable('nps_feedback', {
  orderId: bigint('order_id', { mode: 'bigint' }),
  questionId: int('question_id'),
  feedback: varchar('feedback_answer', { length: 255 }).notNull(),
  createdAt: datetime('created_at', { mode: 'string' }),
});
export const NpsQuestion = mysqlTable('nps_questions', {
  id: int('id').primaryKey(),
  question: varchar('question', { length: 255 }),
});
