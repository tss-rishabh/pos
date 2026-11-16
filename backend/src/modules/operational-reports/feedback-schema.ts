import { bigint, int, datetime, mysqlTable, text } from 'drizzle-orm/mysql-core';
/** Read-only mapping of external source tables; never migrate these tables. */
export const NpsFeedback = mysqlTable('nps_feedback', {
  orderId: bigint('order_id', { mode: 'bigint' }),
  questionId: int('question_id'),
  feedback: text('feedback_answer'),
  createdAt: datetime('created_at', { mode: 'string' }),
});
export const NpsQuestion = mysqlTable('nps_questions', {
  id: int('id').primaryKey(),
  question: text('question'),
});
