import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AdministrationTransaction } from '../../administration/checkins.js';
import { counterError, counterOwner } from './contracts.js';
/** Independent publisher/trigger definer has separate credentials. Ordinary
 * application connections may SELECT the projection and read fixed audit metadata,
 * but cannot forge totals, execute maintenance, change a definer or grant it. */
export const counterPrivilegeSql = `SELECT 'global' AS scope,PRIVILEGE_TYPE AS privilegeName,'' AS objectName,IS_GRANTABLE AS grantable FROM information_schema.USER_PRIVILEGES WHERE GRANTEE=CONCAT("'",REPLACE(CURRENT_USER(),'@',"'@'"),"'")
UNION ALL SELECT 'schema',PRIVILEGE_TYPE,'',IS_GRANTABLE FROM information_schema.SCHEMA_PRIVILEGES WHERE TABLE_SCHEMA=DATABASE() AND GRANTEE=CONCAT("'",REPLACE(CURRENT_USER(),'@',"'@'"),"'")
UNION ALL SELECT 'table',PRIVILEGE_TYPE,TABLE_NAME,IS_GRANTABLE FROM information_schema.TABLE_PRIVILEGES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN('pos_rewrite_screening_counter_heads','pos_rewrite_screening_counters','pos_rewrite_screening_contributions') AND GRANTEE=CONCAT("'",REPLACE(CURRENT_USER(),'@',"'@'"),"'")
UNION ALL SELECT 'column',PRIVILEGE_TYPE,TABLE_NAME,IS_GRANTABLE FROM information_schema.COLUMN_PRIVILEGES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN('pos_rewrite_screening_counter_heads','pos_rewrite_screening_counters','pos_rewrite_screening_contributions') AND GRANTEE=CONCAT("'",REPLACE(CURRENT_USER(),'@',"'@'"),"'")`;
const checked = new WeakMap<AdministrationTransaction, string>();
export function validCounterPrivileges(rows: unknown) {
  const values = z
    .array(
      z.object({
        scope: z.enum(['global', 'schema', 'table', 'column']),
        privilegeName: z.string(),
        objectName: z.string(),
        grantable: z.enum(['YES', 'NO']),
      }),
    )
    .max(1000)
    .safeParse(rows);
  return (
    values.success &&
    values.data.every(
      (row) =>
        ['SELECT', 'USAGE', 'SHOW_ROUTINE'].includes(row.privilegeName) && row.grantable === 'NO',
    )
  );
}
export async function assertCounterRuntimePrivileges(tx: AdministrationTransaction, owner: string) {
  counterOwner.parse(owner);
  if (checked.get(tx) === owner) return;
  const [raw] = await tx.execute(sql`SELECT CURRENT_USER() AS actor,CURRENT_ROLE() AS roles`);
  const identity = z
    .array(z.object({ actor: counterOwner, roles: z.literal('NONE') }))
    .length(1)
    .safeParse(raw);
  if (!identity.success || identity.data[0]!.actor === owner)
    throw counterError('APPLICATION_GRANTS');
  const [privileges] = await tx.execute(sql.raw(counterPrivilegeSql));
  if (!validCounterPrivileges(privileges)) throw counterError('APPLICATION_GRANTS');
  const [schemaRows] = await tx.execute(sql`SELECT DATABASE() AS name`);
  const schema = z
    .array(z.object({ name: z.string().regex(/^[A-Za-z0-9_]{1,64}$/) }))
    .length(1)
    .safeParse(schemaRows);
  if (!schema.success) throw counterError('APPLICATION_GRANTS');
  const metadataGrant = new RegExp(
    '^GRANT EXECUTE ON FUNCTION `?' +
      schema.data[0]!.name +
      '`?\\.`?pos_rewrite_origin_(?:history|transaction)_metadata`? TO .+$',
    'i',
  );
  const [rawGrants] = await tx.execute(sql.raw('SHOW GRANTS FOR CURRENT_USER'));
  const grants = z.array(z.record(z.string(), z.string())).max(1000).safeParse(rawGrants);
  if (
    !grants.success ||
    grants.data.some(
      (row) =>
        Object.keys(row).length !== 1 ||
        Object.values(row).some(
          (value) =>
            /\b(?:TRIGGER|PROXY)\b|\bWITH GRANT OPTION\b/i.test(value) ||
            (/\bEXECUTE\b/i.test(value) && !metadataGrant.test(value)),
        ),
    )
  )
    throw counterError('APPLICATION_GRANTS');
  checked.set(tx, owner);
}
