/** Browser/WebView caller after the original successful MPos login. The real
 * HttpOnly cookie and customer JWT remain their independent original proofs.
 * Storage contains only captured scope, command/draft and a payload digest. */
const KEY='tss.screening.mpos-command.v1',UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
  ID=/^[1-9][0-9]{0,18}$/;
function fail(){throw new Error('Keep the original MPos screening command and check its outcome.');}
function load(storage){
  const raw=storage.getItem(KEY);if(raw===null)return null;
  let value;try{value=JSON.parse(raw);}catch{fail();}
  if(!value||Object.keys(value).sort().join(',')!=='actorId,commandId,counterId,customerId,draftId,phase,requestHash,storeId,v'||value.v!==1||
    !UUID.test(value.commandId)||!UUID.test(value.draftId)||!['actorId','customerId','storeId','counterId'].every((key)=>ID.test(value[key]))||
    !/^[a-f0-9]{64}$/.test(value.requestHash)||!['PREPARED','DISPATCHED','RECONCILING','CREATED','PAYMENT_SENT','COMPLETE'].includes(value.phase))fail();
  return value;
}
function save(storage,value){storage.setItem(KEY,JSON.stringify(value));if(JSON.stringify(load(storage))!==JSON.stringify(value))fail();}
async function hash(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map((v)=>v.toString(16).padStart(2,'0')).join('');}
export function mposScreeningCommands({apiOrigin,currentScope,credential,signal,storage=sessionStorage,fetcher=fetch,
  grantPath='/screening-origins/mpos/grants',paymentPath=(id)=>'/screening-origins/mpos/payments/'+id}){
  const api=new URL(apiOrigin);if(api.protocol!=='https:'||api.username||api.password||api.pathname!=='/'||api.search||api.hash||location.protocol!=='https:')fail();
  const capture=()=>{signal.throwIfAborted();const raw=currentScope(),value=Object.fromEntries(['actorId','customerId','storeId','counterId'].map((name)=>[name,String(raw[name])]));if(!Object.values(value).every((id)=>ID.test(id)))fail();return value;};
  const equal=(a,b)=>['actorId','customerId','storeId','counterId'].every((name)=>a[name]===b[name]);
  const current=(owner)=>{signal.throwIfAborted();if(!equal(capture(),owner))fail();};
  const local=(path)=>{const url=new URL(path,location.href);if(url.origin!==location.origin||url.search||url.hash)fail();return url;};
  async function request(url,init,owner){
    current(owner);const token=credential();if(typeof token!=='string'||!token)fail();
    const response=await fetcher(url,{...init,signal,credentials:'include',redirect:'error',headers:{Accept:'application/json',Authorization:token,...init.headers}});
    const value=await response.json();current(owner);return {response,value};
  }
  async function authorization(payload,owner){
    const csrf=await request(local(grantPath),{method:'GET'},owner);
    if(!csrf.response.ok||csrf.value.actorId!==owner.actorId||csrf.value.origin!=='mpos'||typeof csrf.value.csrfToken!=='string')fail();
    const result=await request(local(grantPath),{method:'POST',headers:{'Content-Type':'application/json','X-CSRFToken':csrf.value.csrfToken,'X-TSS-Screening-Actor':owner.actorId},body:JSON.stringify({payload})},owner);
    if(!result.response.ok||result.value.origin!=='mpos'||!UUID.test(result.value.grantId))fail();
    return {csrf:csrf.value.csrfToken,headers:{'Content-Type':'application/json','X-TSS-Screening-Origin':'mpos','X-TSS-Screening-Staff-Grant':result.value.grantId}};
  }
  function pending(owner){const value=load(storage);if(value&&!equal(value,owner))fail();return value;}
  return {
    pending(){return pending(capture());},
    async prepare({draftId,payload}){
      const owner=capture();if(!UUID.test(draftId)||String(payload.store_id)!==owner.storeId||String(payload.counter_id)!==owner.counterId)fail();
      const requestHash=await hash(payload);current(owner);let value=pending(owner);
      if(value&&(value.draftId!==draftId||value.requestHash!==requestHash||value.phase!=='PREPARED'))fail();
      value??={v:1,...owner,draftId,commandId:crypto.randomUUID(),requestHash,phase:'PREPARED'};save(storage,value);
      const auth=await authorization(payload,owner);
      const result=await request(new URL('/api/v2/screening-commands',api),{method:'POST',headers:auth.headers,body:JSON.stringify({commandId:value.commandId,payload,params:{},kind:'pos'})},owner);
      if(!result.response.ok||result.value.commandId!==value.commandId||result.value.prepared!==true)fail();return Object.freeze({...value});
    },
    async submit(intent,payload){
      const owner=capture();let value=pending(owner);if(!value||value.commandId!==intent.commandId||value.phase!=='PREPARED'||await hash(payload)!==value.requestHash)fail();current(owner);
      const auth=await authorization(payload,owner);value={...value,phase:'DISPATCHED'};save(storage,value);
      try{
        const result=await request(new URL('/api/v2/pos/order',api),{method:'POST',headers:{...auth.headers,'X-TSS-Screening-Command':value.commandId},body:JSON.stringify(payload)},owner);
        if(!result.response.ok||result.response.headers.get('X-TSS-Screening-Origin-Contract')!=='pos-screening-origins-v1'||result.value?.isValid!==true||result.value.name!=='placed_order')fail();
        save(storage,{...value,phase:'CREATED'});return result.value;
      }catch(error){current(owner);save(storage,{...value,phase:'RECONCILING'});throw error;}
    },
    async recover(payload){
      const owner=capture(),value=pending(owner);if(!value||await hash(payload)!==value.requestHash)fail();current(owner);
      const auth=await authorization(payload,owner),result=await request(new URL('/api/v2/screening-commands/'+value.commandId,api),{method:'GET',headers:auth.headers},owner);
      if(result.response.status===404)return {commandId:value.commandId,phase:'missing'};
      if(!result.response.ok||result.value.commandId!==value.commandId)fail();
      if(['BOUND','COUNTED'].includes(result.value.phase)&&result.value.result?.isValid===true)save(storage,{...value,phase:value.phase==='COMPLETE'?'COMPLETE':'CREATED'});
      return result.value;
    },
    async payment(originalResult,payload){
      const owner=capture();let value=pending(owner);if(!value||!['CREATED','PAYMENT_SENT'].includes(value.phase)||await hash(payload)!==value.requestHash)fail();current(owner);
      const auth=await authorization(payload,owner);value={...value,phase:'PAYMENT_SENT'};save(storage,value);
      const result=await request(local(paymentPath(value.commandId)),{method:'POST',headers:{'Content-Type':'application/json','X-CSRFToken':auth.csrf,'X-TSS-Screening-Actor':owner.actorId,'X-TSS-Screening-Command':value.commandId},body:JSON.stringify(originalResult)},owner);
      if(!result.response.ok)fail();if(result.value.status==='CONFIRMED')save(storage,{...value,phase:'COMPLETE'});return result.value;
    },
    acknowledge(){const owner=capture(),value=pending(owner);if(!value||value.phase!=='COMPLETE')fail();storage.removeItem(KEY);if(storage.getItem(KEY)!==null)fail();},
  };
}
