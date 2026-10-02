'use strict';
require('./config.cjs').applyEnvironment();
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {CodexClient}=require('./codex-client.cjs'),routing=require('./routing.cjs');
const {ReplyForwarder}=require('./reply-forwarder.cjs');
const {PeerDialogueForwarder}=require('./peer-dialogue-forwarder.cjs');
const {isUserCommand:recognizeUserCommand}=require('./command-prefix.cjs');
const state=require('./config.cjs').statePath('harness-event-relay');
const mailboxHome=require('./config.cjs').statePath('harness-mailbox');
const DISCOVERY_INTERVAL_MS=2000;
const {atomic}=require('./atomic-json.cjs');
function isGlobal(config){return config.commandScope==='all-sessions';}
function scopeKey(config){return JSON.stringify([config.commandScope,config.globalEnabledAt]);}
function validateGlobal(config){
 if(typeof config.globalEnabledAt!=='string'||!Number.isFinite(Date.parse(config.globalEnabledAt)))throw Error('Global commands need an explicit activation time');
}
function commandSessionIds(config,r,discovered=new Set()){
 if(isGlobal(config)){validateGlobal(config);return new Set([...discovered].filter(id=>Object.hasOwn(config.sessions||{},id)));}
 return new Set(Object.keys(config.sessions||{}).filter(id=>r.groups?.[id]?.receiveCommands));
}
// Global scope widens source discovery only. Destination always follows the
// existing latest/groups routing; obsolete config/inbox targets are ignored.
function commandTarget(_config,sessionId,target=routing.target){return target(sessionId);}
function resolveCommandRoute(config,sessionId,readRouting=routing.read,target=routing.target){
 try{return {threadId:commandTarget(config,sessionId,target)};}
 catch(e){const r=readRouting();if(r.mode==='groups'&&!routing.validThread(r.groups?.[sessionId]?.threadId))return {unroutableSession:sessionId,error:e.message};throw e;}
}
function routingKey(r){return JSON.stringify([r.mode,r.mode==='latest'?r.current.threadId:r.groups]);}
function shouldDeliver(item,allowed,eligible,deliveryExists){return eligible(item,allowed)&&!deliveryExists(item.id);}
function nativeDialogueEntry(policy,item){return policy?.enabled===true&&item.message?.origin==='user-window'&&item.message?.kind==='task';}
function pollSessionErrors(errors){return errors.filter(error=>!Number.isInteger(error.seq));}
function isHarnessUnavailable(error){
 return ['harness_not_running','http_502','http_503','http_504','ECONNREFUSED','ECONNRESET','ETIMEDOUT'].includes(error?.code)
  ||/Open DeepSeek Harness Desktop first|fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|operation was aborted due to timeout|Harness returned HTTP 50[234]/i.test(error?.message||'');
}

// Local session discovery never sends a model prompt. Injectable dependencies
// exercise discovery, subscription races and recovery entirely offline.
class CommandSessionManager {
 constructor({readConfig,readRouting,discover,createHarness,WebSocket,parseUserCommand,isUserCommand=recognizeUserCommand,onCommand,onStatus,onFatal,onChange=()=>{},onRecovered=()=>{},onUserMessage=()=>{},onSessionFrame=()=>{},extraSessionIds=()=>[],setTimer=setTimeout,clearTimer=clearTimeout}){
  Object.assign(this,{readConfig,readRouting,discover,createHarness,WebSocket,parseUserCommand,isUserCommand,onCommand,onStatus,onFatal,onChange,onRecovered,onUserMessage,onSessionFrame,extraSessionIds,setTimer,clearTimer});
  this.streams=new Map();this.discovered=new Set();this.view={allowed:new Set()};this.stopped=false;this.refreshPending=false;this.discoverPending=false;this.refreshPromise=null;this.wasOffline=false;
 }
 start(){return this.refresh(true);}
 refresh(discover=false){
  if(this.stopped)return Promise.resolve();
  this.refreshPending=true;this.discoverPending||=discover;
  if(this.refreshPromise)return this.refreshPromise;
  this.refreshPromise=this.refreshLoop().finally(()=>{this.refreshPromise=null;this.scheduleDiscovery();});
  return this.refreshPromise;
 }
 async refreshLoop(){
  try{while(this.refreshPending&&!this.stopped){
   this.refreshPending=false;const config=this.readConfig(),key=scopeKey(config);
   const discover=this.discoverPending||key!==this.lastDiscoveryKey;this.discoverPending=false;
   if(isGlobal(config)){
    validateGlobal(config);
    if(discover){
     let result;
     try{result=await this.discover();}
     catch(e){if(!isHarnessUnavailable(e))throw e;this.wasOffline=true;this.onStatus({state:'reconnecting',commandScope:'all-sessions',discoveryError:e.message});break;}
     if(this.stopped)return;
     // A scope/activation change during an asynchronous list cannot install
     // stale subscriptions. Destination routing is resolved when delivering.
     const current=this.readConfig();if(scopeKey(current)!==key){this.refreshPending=true;this.discoverPending=true;continue;}
     if(!Array.isArray(result.sessionIds)||result.sessionIds.some(id=>typeof id!=='string'||!/^[-a-zA-Z0-9_]{1,160}$/.test(id)))throw Error('Unexpected command discovery response');
     this.discovered=new Set(result.sessionIds);this.lastDiscoveryKey=key;
     if(this.wasOffline){this.wasOffline=false;this.onRecovered();}
    }
   }else{this.lastDiscoveryKey=key;this.discovered.clear();}
   const current=this.readConfig(),currentRouting=this.readRouting();
   this.view={config:current,routing:currentRouting,allowed:commandSessionIds(current,currentRouting,this.discovered)};
   this.onStatus({threadId:currentRouting.mode==='latest'?currentRouting.current.threadId:null,routing:currentRouting.mode,commandScope:current.commandScope||'bound-sessions',sessionDiscoveryIntervalMs:isGlobal(current)?DISCOVERY_INTERVAL_MS:null,commandSessions:[...this.view.allowed],groups:currentRouting.groups});
   this.reconcile(new Set([...this.view.allowed,...this.extraSessionIds()]));this.onChange(this.view);
  }}catch(e){this.onFatal(e);}
 }
 scheduleDiscovery(){
  if(this.stopped||!isGlobal(this.readConfig())){this.clearTimer(this.discoveryTimer);this.discoveryTimer=null;return;}
  // Mailbox cursor writes must not postpone discovery of a new window forever.
  if(this.discoveryTimer)return;
  this.discoveryTimer=this.setTimer(()=>{this.discoveryTimer=null;void this.refresh(true);},DISCOVERY_INTERVAL_MS);
 }
 reconcile(allowed){
  for(const [id,entry] of this.streams)if(!allowed.has(id)){this.streams.delete(id);this.clearTimer(entry.timer);entry.ws?.terminate();}
  for(const id of allowed)if(!this.streams.has(id)){const entry={};this.streams.set(id,entry);this.connect(id,entry);}
 }
 active(sessionId,entry,ws){return !this.stopped&&this.streams.get(sessionId)===entry&&(!ws||entry.ws===ws);}
 retry(sessionId,entry){
  if(!this.active(sessionId,entry))return;
  entry.connected=false;this.onStatus({state:'reconnecting'});this.clearTimer(entry.timer);
  entry.timer=this.setTimer(()=>{entry.timer=null;this.connect(sessionId,entry);},entry.backoff||1000);
  entry.backoff=Math.min(30000,(entry.backoff||1000)*2);
 }
 connect(sessionId,entry){
  if(!this.active(sessionId,entry))return;
  try{
   const h=this.createHarness(),streamId=crypto.randomUUID();
   const ws=entry.ws=new this.WebSocket(h.origin.replace('http:','ws:')+'/api/remote.mux',{headers:{Origin:h.origin,Cookie:h.cookie},maxPayload:32*1024*1024,handshakeTimeout:15000});
   ws.on('open',()=>{if(this.active(sessionId,entry,ws))ws.send(JSON.stringify({type:'open',streamId,endpoint:'session/follow',payload:{args:{request:{address:{kind:'session',sessionId},assistantStream:true,maxMessages:50}}}}));});
   ws.on('message',raw=>{if(!this.active(sessionId,entry,ws))return;try{
    const f=JSON.parse(raw);if(f.streamId!==streamId)return;
    if(f.type==='error'){
     if(isGlobal(this.readConfig())){this.onStatus({state:'reconnecting',subscriptionError:'Harness command subscription failed',subscriptionSessionId:sessionId});ws.terminate();return;}
     throw Error('Harness command subscription failed');
    }
    if(f.type!=='item')return;
    this.onSessionFrame(sessionId,f.value);
    if(f.value.type==='snapshot'){
     for(const record of f.value.records||[])if(record.event?.type==='user/message')this.onUserMessage(sessionId,record.event);
     entry.connected=true;entry.backoff=1000;this.onStatus({state:[...this.streams.values()].every(x=>x.connected)?'listening':'connecting',connectedAt:new Date().toISOString()});this.onCommand();
    }else{
     const e=f.value.event||f.value.record?.event;
     if(e?.type==='user/message'){
      this.onUserMessage(sessionId,e);
      const text=(e.data.message?.content||e.data.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('');
      if(this.isUserCommand(text))this.onCommand();
     }
    }
   }catch(e){this.onFatal(e);}});
   ws.on('error',()=>{});ws.on('close',()=>{if(this.active(sessionId,entry,ws))this.retry(sessionId,entry);});
  }catch(e){if(!isHarnessUnavailable(e)){this.onFatal(e);return;}this.wasOffline=true;this.onStatus({state:'reconnecting',connectionError:e.message});this.retry(sessionId,entry);}
 }
 close(){
  if(this.stopped)return;this.stopped=true;this.clearTimer(this.discoveryTimer);
  for(const entry of this.streams.values()){this.clearTimer(entry.timer);entry.ws?.terminate();}this.streams.clear();
 }
}

async function main({eligible,promptFor}){
 fs.mkdirSync(state,{recursive:true});const lock=path.join(state,'relay.lock');const fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
 let client,forwarder,peerForwarder,autoDialogue,manager,stopWatcher,configWatcher,stopped=false,busy=false,dirty=false,pollRetry=false,lastRoutingKey;
 let status={pid:process.pid,startedAt:new Date().toISOString(),mode:'event-driven',modelWakeupInterval:null,codexConnectionId:process.env.CODEX_APP_TOOLS_PIPE_PATH?crypto.createHash('sha256').update(process.env.CODEX_APP_TOOLS_PIPE_PATH).digest('hex').slice(0,16):null};
 function record(v){if(stopped&&v.state!=='stopped')return;status={...status,...v,updatedAt:new Date().toISOString()};atomic(path.join(state,'status.json'),status);}
 function stop(reason){if(stopped)return;stopped=true;stopWatcher?.close();configWatcher?.close();manager?.close();forwarder?.close();autoDialogue?.close();peerForwarder?.close();client?.close();record({state:'stopped',reason});fs.closeSync(fd);fs.unlinkSync(lock);}
 try{
  process.env.HARNESS_MAILBOX_STATE=mailboxHome;
  const mailbox=require('./mailbox.cjs'),{Harness}=require('./bridge.cjs');
  const WS=require(path.join(path.dirname(process.execPath),'resources/app.asar/dsh/node_modules/ws'));
  const readConfig=()=>JSON.parse(fs.readFileSync(path.join(mailboxHome,'config.json'),'utf8'));
  function currentView(){const config=readConfig(),r=routing.read();return {config,routing:r,allowed:commandSessionIds(config,r,manager?.discovered)};}
  async function drain(){dirty=true;if(busy||stopped)return;busy=true;
   try{while(dirty&&!stopped){dirty=false;const {allowed}=currentView();
    const polled=await mailbox.execute({command:'poll',sessionIds:[...allowed]}),errors=pollSessionErrors(polled.errors);if(errors.length)throw Error(JSON.stringify(errors));pollRetry=false;
    if(polled.errors.length)record({lastRejectedCommandAt:new Date().toISOString(),rejectedCommandCount:(status.rejectedCommandCount||0)+polled.errors.length});
    const dir=path.join(mailboxHome,'inbox');const items=fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'))).sort((a,b)=>a.receivedAt.localeCompare(b.receivedAt)):[];
    for(const item of items){if(stopped)break;const view=currentView();if(!shouldDeliver(item,view.allowed,eligible,id=>fs.existsSync(path.join(state,'deliveries',id+'.json'))))continue;
     const out=path.join(state,'deliveries',item.id+'.json');
     const unified=require('./peer-dialogue-state.cjs').read(path.join(require('./peer-dialogue-state.cjs').home,'channel-policy.json'),{});
     if(nativeDialogueEntry(unified,item)){atomic(out,{inboxId:item.id,sessionId:item.sessionId,sourceSeq:item.sourceSeq,status:'native-dialogue-entry',recordedAt:new Date().toISOString(),reason:'Unified native DSH tools own first contact and binding; the legacy latest pointer must not deliver a duplicate command'});continue;}
     const route=resolveCommandRoute(view.config,item.sessionId);
     if(route.unroutableSession){record({unroutableSession:route.unroutableSession,unroutableInboxId:item.id,unroutableAt:new Date().toISOString(),routingError:route.error});continue;}
     const threadId=route.threadId,delivery={inboxId:item.id,sessionId:item.sessionId,sourceSeq:item.sourceSeq,threadId,routingMode:routing.read().mode,commandScope:view.config.commandScope||'bound-sessions',status:'sending',attemptedAt:new Date().toISOString()};atomic(out,delivery);
     try{await client.send(promptFor(item),threadId);atomic(out,{...delivery,status:'accepted',acceptedAt:new Date().toISOString()});record({lastDeliveredInboxId:item.id,lastDeliveryAt:new Date().toISOString()});}
     catch(e){atomic(out,{...delivery,status:'uncertain',error:e.message});stop(e.message);return;}
    }
   }}catch(e){if(isGlobal(readConfig())&&isHarnessUnavailable(e)){pollRetry=true;record({state:'reconnecting',pollError:e.message});}else stop(e.message);}finally{busy=false;}
  }
  client=new CodexClient();await client.start();
  peerForwarder=new PeerDialogueForwarder(client,{onStatus:record,onError:e=>record({lastPeerError:e.message,lastPeerErrorAt:new Date().toISOString()}),verifySource:(m,c)=>{const h=new Harness();return require('./peer-dsh-source.cjs').verifyDSHSource(m,c,{readHistory:sessionId=>h.history(sessionId,{maxPages:8}),readSummary:async sessionId=>(await h.list()).find(s=>s.sessionId===sessionId)});}});
  autoDialogue=new(require('./peer-auto-dialogue.cjs').PeerAutoDialogue)({peer:peerForwarder,sendGPT:req=>require('./dialogue.cjs').execute(req),readDSH:sessionId=>new Harness().history(sessionId,{maxPages:8}),onStatus:value=>{record(value);void manager?.refresh();},onError:e=>record({lastAutoError:e.message,lastAutoErrorAt:new Date().toISOString()})});
  manager=new CommandSessionManager({readConfig,readRouting:routing.read,discover:()=>mailbox.execute({command:'discover'}),createHarness:()=>new Harness(),WebSocket:WS,isUserCommand:recognizeUserCommand,onCommand:()=>void drain(),onStatus:record,onFatal:e=>stop(e.message),onUserMessage:(sessionId,e)=>void peerForwarder.onUserMessage(sessionId,e).catch(error=>record({lastPeerError:error.message})),onChange:view=>{const key=routingKey(view.routing),changed=lastRoutingKey!==undefined&&key!==lastRoutingKey;lastRoutingKey=key;if(pollRetry||changed)void drain();},onRecovered:()=>{
   // ReplyForwarder retains its task authorization and routing. A failed
   // constructor while the desktop was closed needs a fresh socket after return.
   if(forwarder&&!forwarder.stopped){for(const [id,entry] of forwarder.streams)if(!entry.ws||entry.ws.readyState>=2){clearTimeout(entry.timer);forwarder.connect(id,entry);}void forwarder.scan();}
  }});
  manager.onSessionFrame=(sessionId,frame)=>autoDialogue.onDSHFrame(sessionId,frame);
  manager.extraSessionIds=()=>autoDialogue.sessionIds();
  const stopFile=path.join(state,'stop.request');if(fs.existsSync(stopFile))fs.unlinkSync(stopFile);
  stopWatcher=fs.watch(state,(_,name)=>{if(name==='stop.request'&&fs.existsSync(stopFile))stop('Stop requested');});
  configWatcher=fs.watch(mailboxHome,(_,name)=>{if(name==='config.json')void manager.refresh();});
  forwarder=new ReplyForwarder(client,e=>{if(isGlobal(readConfig())&&isHarnessUnavailable(e)){manager.wasOffline=true;record({state:'reconnecting',replyConnectionError:e.message});}else stop(e.message);},()=>void manager.refresh());
  process.once('SIGTERM',()=>stop('SIGTERM'));process.once('SIGINT',()=>stop('SIGINT'));
  await manager.start();
  if(!stopped){forwarder.start();peerForwarder.start();autoDialogue.start();}
 }catch(e){stop(e.message);process.exitCode=1;}
}
module.exports={main,CommandSessionManager,commandSessionIds,commandTarget,resolveCommandRoute,routingKey,shouldDeliver,nativeDialogueEntry,pollSessionErrors,isHarnessUnavailable,DISCOVERY_INTERVAL_MS};
