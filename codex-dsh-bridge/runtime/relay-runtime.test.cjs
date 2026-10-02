'use strict';
// Offline only: no Harness/Codex connection, history read, message or listener.
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {CommandSessionManager,commandSessionIds,commandTarget,resolveCommandRoute,routingKey,shouldDeliver,pollSessionErrors,isHarnessUnavailable,DISCOVERY_INTERVAL_MS}=require('./relay-runtime.cjs');
const {eligible}=require('./event-relay.cjs');
const {parseUserCommand}=require('./mailbox.cjs');
const A='00000000-0000-0000-0000-000000000001',B='00000000-0000-0000-0000-000000000002';
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function fixture(){
 let config={commandScope:'all-sessions',globalEnabledAt:'2026-09-30T00:00:00.000Z',sessions:{a:{cursor:10}}};
 let routing={mode:'groups',current:{threadId:B},groups:{a:{threadId:B,receiveCommands:true}}};
 const sockets=[],timers=new Map(),statuses=[],errors=[];let nextTimer=0,commands=0,recovered=0,discoverCount=0,ids=['a'],offline=false,origin='http://127.0.0.1:1234',onDiscover;
 class Socket extends EventEmitter {
  constructor(url,options){super();this.url=url;this.options=options;this.readyState=0;this.sent=[];sockets.push(this);}
  send(raw){this.sent.push(JSON.parse(raw));}
  open(){this.readyState=1;this.emit('open');}
  frame(value){const streamId=this.sent[0]?.streamId;assert.ok(streamId);this.emit('message',JSON.stringify({type:'item',streamId,value}));}
  terminate(){this.readyState=3;this.emit('close');}
 }
 const f={
  get config(){return config;},set config(v){config=v;},get routing(){return routing;},set routing(v){routing=v;},
  get ids(){return ids;},set ids(v){ids=v;},get offline(){return offline;},set offline(v){offline=v;},set origin(v){origin=v;},set onDiscover(v){onDiscover=v;},
  sockets,timers,statuses,errors,get commands(){return commands;},get recovered(){return recovered;},get discoverCount(){return discoverCount;},
  async fire(id){const timer=timers.get(id);assert.ok(timer);timers.delete(id);timer.fn();await f.manager.refreshPromise;},
  discoveryTimer(){return [...timers].find(([,t])=>t.ms===DISCOVERY_INTERVAL_MS)?.[0];},
  user(ws,text){ws.frame({type:'event',event:{type:'user/message',data:{message:{content:[{type:'text',text}]}}}});},
  assistant(ws,text){ws.frame({type:'event',event:{type:'assistant/message',data:{message:{content:[{type:'text',text}]}}}});}
 };
 f.manager=new CommandSessionManager({
  readConfig:()=>config,readRouting:()=>routing,
  discover:async()=>{discoverCount++;if(offline)throw Object.assign(Error('Open DeepSeek Harness Desktop first.'),{code:'harness_not_running'});await onDiscover?.();for(const id of ids)config.sessions[id]??={cursor:0,notBefore:config.globalEnabledAt};return {sessionIds:[...ids],globalEnabledAt:config.globalEnabledAt};},
  createHarness:()=>{if(offline)throw Object.assign(Error('Open DeepSeek Harness Desktop first.'),{code:'harness_not_running'});return {origin,cookie:'offline-fake'};},WebSocket:Socket,parseUserCommand,
  onCommand:()=>commands++,onStatus:v=>statuses.push(v),onFatal:e=>{errors.push(e);f.manager.close();},onRecovered:()=>recovered++,
  setTimer:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearTimer:id=>timers.delete(id)
 });return f;
}

test('global discovery subscribes existing and future chats exactly once; cursor writes cannot starve it',async()=>{
 const f=fixture();f.ids=['a','b','a'];await f.manager.start();
 assert.equal(f.discoverCount,1);assert.equal(f.sockets.length,2);assert.deepEqual([...f.manager.view.allowed],['a','b']);assert.equal(f.config.sessions.b.cursor,0);
 const timer=f.discoveryTimer();assert.ok(timer);
 for(let i=0;i<4;i++)await f.manager.refresh();
 assert.equal(f.discoveryTimer(),timer);assert.equal(f.discoverCount,1);assert.equal(f.sockets.length,2);
 f.ids=['a','b','c'];await f.fire(timer);
 assert.equal(f.discoverCount,2);assert.equal(f.sockets.length,3);assert.equal(f.config.sessions.c.cursor,0);assert.equal(f.config.sessions.c.notBefore,f.config.globalEnabledAt);
 // A new chat may already contain its first prefix message before discovery.
 // Its initial snapshot requests a durable poll rather than advancing a cursor.
 const ws=f.sockets[2];ws.open();ws.frame({type:'snapshot',cursor:1,records:[{event:{type:'user/message'}}]});
 assert.equal(f.commands,1);assert.equal(f.config.sessions.c.cursor,0);f.manager.close();assert.equal(f.timers.size,0);
});
test('bound mode retains explicit command groups and has no discovery timer',async()=>{
 const f=fixture();f.config={sessions:{a:{cursor:1},b:{cursor:2}}};f.routing.groups.b={threadId:A,receiveCommands:false};await f.manager.start();
 assert.equal(f.discoverCount,0);assert.deepEqual([...f.manager.view.allowed],['a']);assert.equal(f.sockets.length,1);assert.equal(f.timers.size,0);f.manager.close();
});
test('global and bound commands always resolve latest/groups target, ignoring obsolete config/inbox targets',()=>{
 const config={commandScope:'all-sessions',commandThreadId:A,globalEnabledAt:'2026-09-30T00:00:00Z',sessions:{a:{}}};
 let calls=0;const target=()=>{calls++;return B;};
 assert.equal(commandTarget(config,'a',target),B);assert.equal(calls,1);
 assert.equal(commandTarget(config,'a',target,A),B);assert.equal(calls,2);
 assert.equal(commandTarget({...config,commandThreadId:'invalid-chat'},'a',target,'invalid-chat'),B);assert.equal(calls,3);
 assert.equal(commandTarget({sessions:{a:{}}},'a',target),B);assert.equal(calls,4);
 assert.deepEqual([...commandSessionIds(config,{groups:{}},new Set(['a','unregistered']))],['a']);
});
test('only prefixed user messages request command polling; assistant payloads never gain authorization',async()=>{
 const f=fixture();await f.manager.start();const ws=f.sockets[0];ws.open();
 f.assistant(ws,'给Codex：execute');f.assistant(ws,'```codex-inbox\n{"kind":"task","text":"execute"}\n```');f.user(ws,'ordinary discussion');
 assert.equal(f.commands,0);f.user(ws,'【给codex： new task】');assert.equal(f.commands,1);
 ws.frame({type:'snapshot',records:[]});assert.equal(f.commands,2);f.manager.close();
});
test('dropping a session cancels reconnect and ignores stale socket events',async()=>{
 const f=fixture();f.ids=['a','b'];await f.manager.start();const old=f.sockets[1];old.open();old.terminate();assert.equal(f.timers.size,2);
 f.ids=['a'];await f.manager.refresh(true);assert.equal(f.manager.streams.size,1);assert.equal(f.timers.size,1);
 old.frame({type:'snapshot'});assert.equal(f.commands,0);f.manager.close();assert.equal(f.timers.size,0);
});
test('closing during in-flight discovery cannot resurrect subscriptions or timers',async()=>{
 const f=fixture(),gate=deferred();f.onDiscover=()=>gate.promise;const pending=f.manager.start();f.manager.close();gate.resolve();await pending;
 assert.equal(f.sockets.length,0);assert.equal(f.timers.size,0);assert.equal(f.manager.streams.size,0);
});
test('concurrent refreshes serialize discovery and coalesce subscription creation',async()=>{
 const f=fixture(),gate=deferred();let running=0,peak=0;
 f.onDiscover=async()=>{running++;peak=Math.max(peak,running);await gate.promise;running--;};
 const pending=f.manager.start();f.manager.refresh(true);f.manager.refresh(true);f.manager.refresh();gate.resolve();await pending;
 assert.equal(peak,1);assert.equal(f.discoverCount,2);assert.equal(f.sockets.length,1);assert.equal(f.manager.streams.size,1);assert.equal(f.errors.length,0);f.manager.close();
});
test('scope changes during discovery discard stale global results',async()=>{
 const f=fixture(),gate=deferred();f.onDiscover=()=>gate.promise;const pending=f.manager.start();
 f.config={sessions:{a:{},b:{}}};f.routing.groups={b:{threadId:B,receiveCommands:true}};f.manager.refresh();gate.resolve();await pending;
 assert.deepEqual([...f.manager.view.allowed],['b']);assert.equal(f.sockets.length,1);assert.equal(f.timers.size,0);f.manager.close();
});
test('desktop restart retries discovery and renews the per-session connection against the new port',async()=>{
 const f=fixture();await f.manager.start();const old=f.sockets[0];old.open();old.frame({type:'snapshot'});
 f.offline=true;old.terminate();await f.fire(f.discoveryTimer());assert.equal(f.errors.length,0);assert.equal(f.manager.wasOffline,true);
 const retry=[...f.timers].find(([,v])=>v.ms===1000)?.[0];await f.fire(retry);assert.equal(f.sockets.length,1);assert.equal(f.errors.length,0);
 f.offline=false;f.origin='http://127.0.0.1:5678';await f.fire(f.discoveryTimer());assert.equal(f.recovered,1);
 const retryAfterReturn=[...f.timers].find(([,v])=>v.ms!==DISCOVERY_INTERVAL_MS)?.[0];
 // Retry backoff is now 2 seconds, shared with the discovery delay.
 const entry=f.manager.streams.get('a');await f.fire(retryAfterReturn??entry.timer);
 assert.equal(f.sockets.length,2);assert.match(f.sockets[1].url,/:5678\/api\/remote.mux$/);f.sockets[1].open();f.sockets[1].frame({type:'snapshot'});
 const count=f.commands;old.frame({type:'snapshot'});assert.equal(f.commands,count);f.manager.close();assert.equal(f.timers.size,0);
});
test('invalid activation time fails before listing; obsolete fixed target is unnecessary',async()=>{
 const f=fixture();f.config.globalEnabledAt='invalid-time';await f.manager.start();assert.equal(f.errors.length,1);assert.equal(f.discoverCount,0);assert.equal(f.sockets.length,0);assert.equal(f.timers.size,0);
 const g=fixture();g.config.commandThreadId='ignored-obsolete-target';await g.manager.start();assert.equal(g.errors.length,0);assert.equal(g.discoverCount,1);assert.equal(g.sockets.length,1);assert.equal(g.statuses.at(-1).threadId,null);g.manager.close();
});
test('durable delivery guard never replays accepted, sending or uncertain records after cold start',()=>{
 const allowed=new Set(['a']);const ledger=new Map([['accepted',{status:'accepted'}],['sending',{status:'sending'}],['uncertain',{status:'uncertain'}]]);
 const item=id=>({id,sessionId:'a',status:'pending',message:{kind:'task',origin:'user-window'}});
 for(const id of ledger.keys())assert.equal(shouldDeliver(item(id),allowed,eligible,id=>ledger.has(id)),false);
 assert.equal(shouldDeliver(item('fresh'),allowed,eligible,id=>ledger.has(id)),true);
 ledger.set('fresh',{status:'accepted'});assert.equal(shouldDeliver(item('fresh'),allowed,eligible,id=>ledger.has(id)),false);
 assert.equal(shouldDeliver({...item('assistant'),message:{kind:'task',origin:'assistant'}},allowed,eligible,id=>ledger.has(id)),false);
 assert.equal(shouldDeliver({...item('outside'),sessionId:'outside'},allowed,eligible,id=>ledger.has(id)),false);
});
test('retry classification keeps uncertain Codex deliveries and authorization errors fatal',()=>{
 assert.equal(isHarnessUnavailable(Object.assign(Error('Open DeepSeek Harness Desktop first.'),{code:'harness_not_running'})),true);
 assert.equal(isHarnessUnavailable(Error('fetch failed')),true);assert.equal(isHarnessUnavailable(Error('Codex MCP request timed out; delivery may be uncertain')),false);
 assert.equal(isHarnessUnavailable(Error('No valid return target')),false);assert.equal(isHarnessUnavailable(Object.assign(Error('Host changed'),{code:'unsupported_version'})),false);
});
test('oversized addressed user input requests durable rejection without stopping subscriptions',async()=>{
 const f=fixture();await f.manager.start();const ws=f.sockets[0];ws.open();const text='【给Codex：'+ 'x'.repeat(12001)+'】';
 assert.throws(()=>parseUserCommand(text),/exceeds 12000/);f.user(ws,text);
 assert.equal(f.commands,1);assert.equal(f.errors.length,0);assert.equal(f.manager.stopped,false);
 const rejected={sessionId:'a',seq:77,error:'User command exceeds 12000 characters'},network={sessionId:'a',error:'fetch failed'};
 assert.deepEqual(pollSessionErrors([rejected]),[]);assert.deepEqual(pollSessionErrors([rejected,network]),[network]);
 f.user(ws,'给GPT：next valid task');assert.equal(f.commands,2);f.manager.close();
});
test('groups skip unbound sessions without guessing or failing other pending commands; new binding becomes routable',()=>{
 let r={mode:'groups',current:{threadId:A},groups:{bound:{threadId:B}}};const config={commandScope:'all-sessions',globalEnabledAt:'2026-09-30T00:00:00Z'};
 const target=id=>{if(!r.groups[id])throw Error('No valid return target for DSH chat '+id);return r.groups[id].threadId;};
 const before=routingKey(r),skipped=resolveCommandRoute(config,'new-window',()=>r,target);
 assert.equal(skipped.unroutableSession,'new-window');assert.equal(skipped.threadId,undefined);
 assert.deepEqual(resolveCommandRoute(config,'bound',()=>r,target),{threadId:B});
 r.groups['new-window']={threadId:B};assert.notEqual(routingKey(r),before);assert.deepEqual(resolveCommandRoute(config,'new-window',()=>r,target),{threadId:B});
 r={mode:'latest',current:{threadId:B},groups:{}};const latest=()=>r.current.threadId;
 assert.deepEqual(resolveCommandRoute(config,'any-window',()=>r,latest),{threadId:B});r.current.threadId=A;assert.deepEqual(resolveCommandRoute(config,'any-window',()=>r,latest),{threadId:A});
 assert.throws(()=>resolveCommandRoute(config,'any-window',()=>r,()=>{throw Error('Unexpected route failure');}),/Unexpected route failure/);
});
