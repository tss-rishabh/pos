import type { AdministrationTransaction } from '../../administration/checkins.js';
import type {
  FinancialImportAuthority,
  ImportFinancialState,
} from '../financial-adapter-contracts.js';
import type { ImportFinancialScope } from '../financial-contracts.js';
import type { ImportSuccessionEnvelope } from './contracts.js';
import { importFinancialError } from '../financial-adapter-primitives.js';
interface Execution {
  scope: ImportFinancialScope;
  original: FinancialImportAuthority;
  grant: ImportSuccessionEnvelope;
  clock: () => number;
}
const scopeKey = (scope: ImportFinancialScope) =>
  JSON.stringify([scope.actorId, scope.operationId, scope.storeId, scope.counterId]);
const scopes = new WeakMap<AdministrationTransaction, string>();
export function registerSuccessionReadScope(
  tx: AdministrationTransaction,
  scope: ImportFinancialScope,
) {
  const key = scopeKey(scope),
    prior = scopes.get(tx);
  if (prior && prior !== key) throw importFinancialError('ORDER_IMPORT_SUCCESSION_SCOPE_CHANGED');
  scopes.set(tx, key);
}
export function successionScopePrefix(tx: AdministrationTransaction, scope: ImportFinancialScope) {
  return scopes.get(tx) === scopeKey(scope);
}
const executions = new WeakMap<AdministrationTransaction, Execution>();
/** Native ledger verifier installs this only after current authority/Store/
 * operation/customer locks. Never exposed as a route/body or mutable state. */
export function installSuccessionExecution(tx: AdministrationTransaction, value: Execution) {
  if (executions.has(tx)) throw importFinancialError('ORDER_IMPORT_SUCCESSION_SCOPE_CHANGED');
  registerSuccessionReadScope(tx, value.scope);
  executions.set(tx, value);
}
export function successionExecution(
  tx: AdministrationTransaction,
  scope: ImportFinancialScope,
  original: FinancialImportAuthority,
) {
  const value = executions.get(tx);
  if (!value) return null;
  if (
    scopeKey(scope) !== scopeKey(value.scope) ||
    JSON.stringify(original) !== JSON.stringify(value.original) ||
    value.clock() >= value.grant.data.expiresAt
  )
    throw importFinancialError('ORDER_IMPORT_SUCCESSION_AUTHORITY_CHANGED');
  return value;
}
export function assertSuccessionExecution(
  tx: AdministrationTransaction,
  state: ImportFinancialState,
) {
  const value = successionExecution(tx, state.scope, state.authority);
  if (
    state.authoritySuccession &&
    (!value ||
      value.grant.data.id !== state.authoritySuccession.id ||
      value.grant.data.sequence !== state.authoritySuccession.sequence ||
      value.grant.sourceHash !== state.authoritySuccession.hash)
  )
    throw importFinancialError('ORDER_IMPORT_SUCCESSION_REQUIRED');
  return value;
}
