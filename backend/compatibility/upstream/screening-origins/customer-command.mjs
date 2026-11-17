/** Genuine source customer browser caller. Existing Authorization stays in the
 * original request header; only nonce/scope/digest metadata may be persisted.
 * No React checkout source was present in the observed empty website repo.
 */
const KEY = 'tss.screening.customer-command.v1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ID = /^[1-9][0-9]{0,18}$/;
function fail() { throw new Error('Keep the original screening reference and check its outcome.'); }
function read(storage) {
  const raw = storage.getItem(KEY);
  if (raw === null) return null;
  let value;
  try { value = JSON.parse(raw); } catch { fail(); }
  if (!value || Object.keys(value).sort().join(',') !== 'commandId,customerId,draftId,phase,requestHash,v' || value.v !== 1 ||
      !UUID.test(value.commandId) || !ID.test(value.customerId) || !UUID.test(value.draftId) ||
      !/^[a-f0-9]{64}$/.test(value.requestHash) || !['PREPARED','DISPATCHED','RECONCILING','COMPLETE'].includes(value.phase)) fail();
  return value;
}
function save(storage, value) {
  storage.setItem(KEY, JSON.stringify(value));
  if (JSON.stringify(read(storage)) !== JSON.stringify(value)) fail();
}
async function hash(value) {
  const data = new TextEncoder().encode(JSON.stringify(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map((byte) => byte.toString(16).padStart(2,'0')).join('');
}
export function customerScreeningCommands({ origin, currentCustomer, credential, signal, storage = sessionStorage, fetcher = fetch }) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) fail();
  const capture = () => {
    signal.throwIfAborted();
    const customerId = String(currentCustomer());
    if (!ID.test(customerId)) fail();
    return customerId;
  };
  const query = (path, params) => {
    const url = new URL(path,base);
    for (const [name,value] of Object.entries(params)) {
      if (name === 'platform' && ['web','app'].includes(value) || name === 'save_user_upi' && ['true','false'].includes(value)) url.searchParams.set(name,value);
      else fail();
    }
    return url;
  };
  async function request(path, options, owner) {
    signal.throwIfAborted();
    if (capture() !== owner) fail();
    const token = credential();
    if (typeof token !== 'string' || !token) fail();
    const response = await fetcher(path instanceof URL ? path : new URL(path, base), { ...options, signal, credentials:'include',redirect:'error',
      headers:{ 'Content-Type':'application/json',Authorization:token,...options.headers } });
    const value = await response.json();
    signal.throwIfAborted();
    if (capture() !== owner) fail();
    return { response, value };
  }
  return {
    pending() { const value = read(storage);return value?.customerId === capture() ? value : null; },
    async prepare({ draftId, payload, params = {} }) {
      const owner = capture();
      if (!UUID.test(draftId)) fail();
      const digest = await hash({payload,params});signal.throwIfAborted();if (capture() !== owner) fail();
      let value = read(storage);
      if (value && (value.customerId !== owner || value.draftId !== draftId || value.requestHash !== digest || value.phase !== 'PREPARED')) fail();
      value ??= { v:1,customerId:owner,draftId,commandId:crypto.randomUUID(),requestHash:digest,phase:'PREPARED' };
      save(storage,value);
      const result = await request(query('/api/v2/screening-commands',params), {method:'POST',body:JSON.stringify({commandId:value.commandId,payload,params,kind:'customer'})},owner);
      if (!result.response.ok || result.value.commandId !== value.commandId || result.value.prepared !== true) fail();
      return Object.freeze({commandId:value.commandId,customerId:owner,draftId,requestHash:digest});
    },
    async submit(intent, { payload, params = {} }) {
      const owner = capture();let value = read(storage);
      if (!value || value.customerId !== owner || value.commandId !== intent.commandId || value.draftId !== intent.draftId || value.phase !== 'PREPARED') fail();
      if (await hash({payload,params}) !== value.requestHash) fail();signal.throwIfAborted();if (capture() !== owner) fail();
      value = {...value,phase:'DISPATCHED'};save(storage,value);
      try {
        const result = await request(query('/api/v2/order',params), {method:'POST',body:JSON.stringify(payload),headers:{'X-TSS-Screening-Command':value.commandId}},owner);
        if (!result.response.ok || result.response.headers.get('X-TSS-Screening-Origin-Contract') !== 'pos-screening-origins-v1' || result.value?.isValid !== true || result.value?.name !== 'placed_order') fail();
        save(storage,{...value,phase:'COMPLETE'});return result.value;
      } catch (error) {
        signal.throwIfAborted();if (capture() === owner) save(storage,{...value,phase:'RECONCILING'});
        throw error;
      }
    },
    async recover() {
      const owner = capture(),value = read(storage);
      if (!value || value.customerId !== owner) fail();
      const result = await request('/api/v2/screening-commands/'+value.commandId,{method:'GET'},owner);
      if (result.response.status === 404) return {phase:'missing',commandId:value.commandId};
      if (!result.response.ok || result.value.commandId !== value.commandId) fail();
      if (['BOUND','COUNTED'].includes(result.value.phase) && result.value.result?.isValid === true) save(storage,{...value,phase:'COMPLETE'});
      return result.value;
    },
  };
}
