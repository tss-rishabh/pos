import { bigint, datetime, int, mysqlTable, varchar } from 'drizzle-orm/mysql-core';

/** Verified read-only projections; never migrated. See mysql-admin-shipping-schema.json and mysql-extra-schema.json. */
export const shippingOrders = mysqlTable('orders', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().notNull(),
  reference: varchar('order_ref_no', { length: 55 }),
  createdAt: datetime('created_at', { mode: 'string' }).notNull(),
  addressId: int('has_address_id'),
});
export const shippingAddresses = mysqlTable('has_addresses', {
  id: int('id').primaryKey().notNull(),
  firstName: varchar('firstname', { length: 32 }).notNull(),
  lastName: varchar('lastname', { length: 32 }).notNull(),
  flat: varchar('flat', { length: 255 }),
  address1: varchar('address1', { length: 35 }).notNull(),
  address2: varchar('address2', { length: 35 }).notNull(),
  address3: varchar('address3', { length: 35 }),
  address4: varchar('address4', { length: 255 }),
  city: varchar('city', { length: 128 }).notNull(),
  postcode: varchar('postcode', { length: 10 }).notNull(),
  phone: varchar('phone_no', { length: 32 }).notNull(),
  zoneId: int('zone_id').notNull(),
  countryId: int('country_id').notNull(),
});
export const shippingZones = mysqlTable('zones', {
  id: int('id').primaryKey().notNull(),
  name: varchar('name', { length: 128 }).notNull(),
});
export const shippingCountries = mysqlTable('countries', {
  id: int('id').primaryKey().notNull(),
  name: varchar('name', { length: 128 }).notNull(),
});
