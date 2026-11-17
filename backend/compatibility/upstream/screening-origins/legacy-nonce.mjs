/** Source create_order.html adapter. Retains only original actor/store/counter,
 * tab/draft and command metadata. No customer, cart, amount, OTP or JWT storage. */
const KEY='tss.screening.legacy-command.v1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ID=/^[1-9][0-9]{0,18}$/;
function unavailable(){throw new Error('Check the original screening command before starting another.');}
function read(storage){
  const raw=storage.getItem(KEY);if(raw===null)return null;
  let value;try{value=JSON.parse(raw);}catch{unavailable();}
  if(!value||Object.keys(value).sort().join(',')!=='actorId,commandId,counterId,state,storeId,tabId,v'||value.v!==1||
    !UUID.test(value.commandId)||![value.actorId,value.storeId,value.counterId].every((id)=>ID.test(id))||
    !/^(?:0|[1-9][0-9]{0,18})$/.test(value.tabId)||!['prepared','sent','reconciling','complete'].includes(value.state))unavailable();
  return value;
}
function save(storage,value){storage.setItem(KEY,JSON.stringify(value));if(JSON.stringify(read(storage))!==JSON.stringify(value))unavailable();}
export function installLegacyScreeningNonce({jquery,currentScope,containsScreening,recoveryPath,showRecovery,storage=sessionStorage}){
  const scope=()=>{
    const raw=currentScope(),value={actorId:String(raw.actorId),storeId:String(raw.storeId),counterId:String(raw.counterId),tabId:String(raw.tabId)};
    if(![value.actorId,value.storeId,value.counterId].every((id)=>ID.test(id))||!/^(?:0|[1-9][0-9]{0,18})$/.test(value.tabId))unavailable();return value;
  };
  const matches=(value,owner)=>['actorId','storeId','counterId','tabId'].every((key)=>value[key]===owner[key]);
  const actualPaths=new Set();
  // The actual pinned template passes reversed source URLs, never guessed paths.
  function registerPaths(paths){for(const path of paths){const url=new URL(path,location.href);if(url.origin!==location.origin||url.search||url.hash)unavailable();actualPaths.add(url.pathname);}}
  function beforeSend(xhr,settings){
    const url=new URL(settings.url,location.href);
    if(url.origin!==location.origin||!actualPaths.has(url.pathname)||String(settings.type||settings.method).toUpperCase()!=='POST')return;
    const owner=scope();let value=read(storage);
    if(!containsScreening()&&!value)return;
    if(value&&(!matches(value,owner)||value.state!=='prepared')){showRecovery(value);return false;}
    value??={v:1,...owner,commandId:crypto.randomUUID(),state:'prepared'};save(storage,value);
    value={...value,state:'sent'};save(storage,value);
    xhr.setRequestHeader('X-TSS-Screening-Command',value.commandId);
    xhr.setRequestHeader('X-TSS-Screening-Actor',owner.actorId);
    xhr.__screeningOwner={...owner,commandId:value.commandId};
  }
  const previous=jquery.ajaxSettings.beforeSend;
  jquery.ajaxSetup({beforeSend(xhr,settings){if(previous&&previous.call(this,xhr,settings)===false)return false;return beforeSend(xhr,settings);}});
  jquery(document).on('ajaxComplete.screeningOrigin',(_event,xhr)=>{
    const owner=xhr.__screeningOwner;if(!owner)return;
    const value=read(storage);if(!value||value.commandId!==owner.commandId||!matches(value,scope()))return;
    let outcome;try{outcome=JSON.parse(xhr.responseText);}catch{}
    const complete=xhr.status===200&&outcome?.status===200&&outcome?.order_id;
    save(storage,{...value,state:complete?'complete':'reconciling'});
    if(!complete)showRecovery({...value,state:'reconciling'});
  });
  async function recover(){
    const owner=scope(),value=read(storage);if(!value||!matches(value,owner))unavailable();
    const url=new URL(recoveryPath(value.commandId),location.href);if(url.origin!==location.origin||url.search||url.hash)unavailable();
    const result=await fetch(url,{method:'GET',credentials:'same-origin',redirect:'error',headers:{Accept:'application/json'}});
    const body=await result.json();const current=read(storage);
    if(!current||current.commandId!==value.commandId||!matches(current,scope()))unavailable();
    if(!result.ok||body.commandId!==value.commandId)unavailable();
    if(['complete','cash-completed'].includes(body.state))save(storage,{...value,state:'complete'});
    showRecovery(body);return body;
  }
  const pending=read(storage);if(pending&&matches(pending,scope())&&pending.state!=='complete')showRecovery(pending);
  function acknowledgeComplete(){
    const value=read(storage);if(!value||!matches(value,scope())||value.state!=='complete')unavailable();
    storage.removeItem(KEY);if(storage.getItem(KEY)!==null)unavailable();
  }
  return {registerPaths,recover,acknowledgeComplete,pending:()=>read(storage)};
}
