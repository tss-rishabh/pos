import { bigint, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

/** Read-only projections verified in evidence/mysql-extra-schema.json; never migrated by the rewrite. */
export const deliverablePincodes = mysqlTable('deliverable_pincodes', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().notNull(),
  pincode: varchar('pincode', { length: 32 }).notNull(),
  city: varchar('city', { length: 20 }).notNull(),
  countryId: int('country_id').notNull(),
  stateId: int('state_id').notNull(),
  latitude: varchar('latitude', { length: 255 }).notNull(),
  longitude: varchar('longitude', { length: 255 }).notNull(),
});
export const locationZones = mysqlTable('zones', {
  id: int('id').primaryKey().notNull(),
  name: varchar('name', { length: 128 }).notNull(),
});
