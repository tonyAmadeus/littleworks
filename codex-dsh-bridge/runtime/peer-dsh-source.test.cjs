'use strict';
// Isolated offline tests. No live app, credentials, model request or global state.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'peer-source-test-'));
process.env.HARNESS_DIALOGUE_STATE=path.join(root,'state');
process.env.HARNESS_ROUTING_STATE=path.join(root,'routing');
const state=require('./peer-dialogue-state.cjs');
const {verifyDSHSource}=require('./peer-dsh-source.cjs');
const {PeerDialogueForwarder,promptFor,automaticForRecipient}=require('./peer-dialogue-forwarder.cjs');
const {replySession}=require('./dialogue.cjs');
const context=require('../dsh/gpt-dialogue-context.cjs');
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function fixture(){const conversationId='test-'+crypto.randomUUID(),workspace=path.join(root,conversationId);
 fs.mkdirSync(workspace);await state.register({version:1,conversationId,sessionId:'original-'+conversationId,
   workspace,spoolRoot:path.join(workspace,'work/bridge'),createdAt:new Date(Date.now()-2000).toISOString(),
   createdByThreadId:A,initialCursor:10,status:'active',maxMessages:null,maxHops:null,stopPolicy:'human-only'});
 return state.configureSourceScope(conversationId,A);
}
function packet(c){return {version:1,messageId:'dsh-'+crypto.randomUUID(),conversationId:c.conversationId,
 from:'dsh',to:'gpt',createdAt:new Date().toISOString(),body:'GPT，新窗口原文 🐋',replyTo:null,expectsReply:true,
 sourceSessionId:'new-window-'+c.conversationId,origin:{version:1,sessionId:'new-window-'+c.conversationId,callId:'call_real_123'}};}
function history(m,alter=()=>{}){const time=Date.now(),events=[
 {type:'turn/start',seq:20,time,data:{turn:2}},
 {type:'assistant/message',seq:21,time,data:{turn:2,message:{content:[{type:'text',text:m.body}]}}},
 {type:'tool/call',seq:22,time,data:{turn:2,callId:m.origin.callId,name:'mcp__gpt_dialogue__send_to_gpt',
  arguments:JSON.stringify({text:m.body,message_id:m.messageId})}}];alter(events);
 return {cursor:22,projections:{title:'真实新窗口'},records:events.map(event=>({event}))};}
function dependencies(m,h=history(m)){return {readHistory:async id=>id===m.sourceSessionId?h:{records:[]},
 readSummary:async id=>id===m.sourceSessionId?{cwd:'C:\\other-workspace'}:null};}
test('kernel execution supplies source metadata; the model cannot choose it in ordinary tool arguments',()=>{
 const source=context.sourceFromExecution({agent:{session:{id:'session-real'}},callId:'call_real:ptc:1'});
 assert.deepEqual(source,{version:1,sessionId:'session-real',callId:'call_real:ptc:1'});
 assert.throws(()=>context.sourceFromExecution({callId:'call_real'}),/real DSH/);
 assert.throws(()=>context.validateSource({version:1,sessionId:'../fake',callId:'call'}),/real DSH/);
});
test('new-window body and actual native call are verified together and replies retain that window',async()=>{
 const c=await fixture(),m=packet(c);let count=0,target;
 const f=new PeerDialogueForwarder({send:async()=>{count++;}},{state,target:id=>{target=id;return A;},
   verifySource:(body,scope)=>verifyDSHSource(body,scope,dependencies(m))});
 await f.deliver(m);await f.deliver(m);
 assert.equal(count,1);assert.equal(target,m.sourceSessionId);
 const latest=state.get(c.conversationId),saved=state.ledger(m.messageId);
 assert.equal(latest.sourceSessions[m.sourceSessionId].initialCursor,22);
 assert.equal(saved.sourceCallId,m.origin.callId);assert.equal(saved.sourceTurn,2);
 assert.equal(saved.digest,state.digest(saved));assert.equal(replySession(latest,m.messageId),m.sourceSessionId);
 assert.equal(replySession(latest,null),c.sessionId);
 await assert.rejects(state.reserve({...m,sourceSessionId:'another-window'}),/conflict/);
});
test('a claimed foreign ID or copied outbox cannot enroll a window without its actual call',async()=>{
 const c=await fixture(),m=packet(c);
 for(const bad of [{...m,origin:undefined},{...m,origin:{...m.origin,callId:'fake_call'}},
   {...m,origin:{...m.origin,sessionId:c.sessionId}}])
  assert.equal((await verifyDSHSource(bad,c,dependencies(m))).verified,false);
 assert.equal(state.get(c.conversationId).sourceSessions[m.sourceSessionId],undefined);
});
test('same-turn assistant body, call arguments, role and activation time all must match',async()=>{
 const c=await fixture(),m=packet(c);
 const changes=[es=>es[1].data.turn=1,es=>es[1].type='user/message',
  es=>es[2].data.arguments=JSON.stringify({text:'different'}),
  es=>es[2].data.arguments=JSON.stringify({text:m.body,message_id:'different-id'}),
  es=>es[2].time=Date.parse(c.sourceScopeEnabledAt)-1];
 for(const change of changes)assert.equal((await verifyDSHSource(m,c,dependencies(m,history(m,change)))).verified,false);
});
test('source authorization is owner-only, idempotent and cannot reopen a stopped scope',async()=>{
 const c=await fixture();await assert.rejects(state.configureSourceScope(c.conversationId,B),/actual owning/);
 assert.deepEqual(await state.configureSourceScope(c.conversationId,A),c);
 const m=packet(c);assert.equal((await verifyDSHSource(m,{...c,sourceScope:'bound-sessions'},dependencies(m))).verified,false);
 await state.stop(c.conversationId,'gpt-user-stop');
 await assert.rejects(state.configureSourceScope(c.conversationId,A),/must not reopen/);
});
test('groups resolve the actual source window and never fall back to the old bound session',async()=>{
 const c=await fixture(),m=packet(c);let sends=0;
 const f=new PeerDialogueForwarder({send:async()=>{sends++;}},{state,
  target:id=>{assert.equal(id,m.sourceSessionId);throw Error('Unbound group');},
  verifySource:(body,scope)=>verifyDSHSource(body,scope,dependencies(m))});
 assert.equal((await f.deliver(m)).status,'blocked');assert.equal(sends,0);
});
test('a terminal rejection stays rejected after later text appears; no hidden replay',async()=>{
 const c=await fixture(),m=packet(c);let verified=false,checks=0,sends=0;
 const f=new PeerDialogueForwarder({send:async()=>{sends++;}},{state,target:()=>A,
   verifySource:async()=>{checks++;return {verified};}});
 await assert.rejects(f.deliver(m),/verification failed/);verified=true;
 assert.equal((await f.deliver(m)).status,'rejected');assert.equal(checks,1);assert.equal(sends,0);
 assert.equal(state.ledger(m.messageId),null);
});
test('native sender keeps immutable identity on same-window retries and rejects another source',async()=>{
 const c=await fixture(),m=packet(c),file=path.join(c.spoolRoot,'send_to_gpt.cjs');
 fs.copyFileSync(path.join(__dirname,'../dsh/send_to_gpt.cjs'),file);
 const {execute}=require(file),req={command:'send',messageId:m.messageId,text:m.body,waitSeconds:0};
 assert.equal((await execute(req,m.origin)).status,'published');
 const dest=path.join(c.spoolRoot,'dsh-to-gpt',m.messageId+'.json'),before=fs.readFileSync(dest,'utf8');
 await execute(req,{...m.origin,callId:'call_retry'});assert.equal(fs.readFileSync(dest,'utf8'),before);
 await assert.rejects(execute(req,{...m.origin,sessionId:'different-window'}),/same source chat/);
 const legacy={command:'send',messageId:'legacy-same-scope',text:'legacy',waitSeconds:0};
 await execute(legacy);const old=fs.readFileSync(path.join(c.spoolRoot,'dsh-to-gpt',legacy.messageId+'.json'),'utf8');
 await execute(legacy,{version:1,sessionId:c.sessionId,callId:'call_legacy_retry'});
 assert.equal(fs.readFileSync(path.join(c.spoolRoot,'dsh-to-gpt',legacy.messageId+'.json'),'utf8'),old);
});
test('MCP request metadata is passed separately while model-supplied source arguments are rejected',async()=>{
 const c=await fixture();for(const file of ['gpt-dialogue-mcp.cjs','gpt-dialogue-context.cjs'])
   fs.copyFileSync(path.join(__dirname,'../dsh',file),path.join(c.spoolRoot,file));
 fs.writeFileSync(path.join(c.spoolRoot,'send_to_gpt.cjs'),"exports.execute=async(req,source)=>({command:req.command,actualSource:source});");
 const {dispatch}=require(path.join(c.spoolRoot,'gpt-dialogue-mcp.cjs'));
 const source={version:1,sessionId:'session-real',callId:'call_real'};
 const request={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'send_to_gpt',arguments:{text:'hello'},_meta:{[context.META_KEY]:source}}};
 const result=await dispatch(request);assert.equal(result.isError,false);
 assert.deepEqual(JSON.parse(result.content[0].text).actualSource,source);
 const bad=await dispatch({...request,params:{...request.params,arguments:{text:'hello',source_session_id:'fake'}}});
 assert.equal(bad.isError,true);assert.match(bad.content[0].text,/Invalid tool arguments/);
});
test('explicit human stop in a verified new source window stops all subsequent forwarding',async()=>{
 const c=await fixture(),m=packet(c),proof=await verifyDSHSource(m,c,dependencies(m));
 await state.bindDSHSource(c.conversationId,proof.registerSource);
 const f=new PeerDialogueForwarder({send:async()=>{}},{state});
 const event={type:'user/message',seq:23,time:Date.now(),data:{content:[{type:'text',text:'停止对话'}],source:{kind:'user',rpcId:'actual-human-stop'}}};
 await f.onUserMessage(m.sourceSessionId,{...event,seq:21});assert.equal(state.get(c.conversationId).status,'active');
 await f.onUserMessage(m.sourceSessionId,event);assert.equal(state.get(c.conversationId).status,'stopped');
});
test('latest routing to a different real Codex chat uses explicit reply instructions for that recipient',async()=>{
 const c={...await fixture(),auto:{enabled:true}},m=packet(c);
 assert.equal(automaticForRecipient({...m,targetThreadId:A},c),true);
 assert.equal(automaticForRecipient({...m,targetThreadId:B},c),false);
 const prompt=promptFor({...m,targetThreadId:B},c);
 assert.ok(prompt.includes('dialogue.cmd send'));assert.ok(prompt.includes('replyTo='+m.messageId));
 assert.ok(!prompt.includes('不要再调用 send'));
});
test('a DSH reply cannot claim a GPT parent addressed to another source window',async()=>{
 const c=await fixture(),m=packet(c),parent={...m,messageId:'gpt-'+crypto.randomUUID(),from:'gpt',to:'dsh',origin:undefined,sourceSessionId:undefined};
 await state.reserve(parent);await state.update(parent.messageId,{status:'accepted',targetSessionId:c.sessionId});
 await assert.rejects(state.reserve({...m,replyTo:parent.messageId}),/another DSH window/);
 await state.update(parent.messageId,{targetSessionId:m.sourceSessionId});
 assert.equal((await state.reserve({...m,replyTo:parent.messageId})).message.replyTo,parent.messageId);
});
test('a default native message ID is tied to its real call; copied text cannot mint another delivery',async()=>{
 const c=await fixture(),m=packet(c),file=path.join(c.spoolRoot,'send_to_gpt.cjs');
 fs.copyFileSync(path.join(__dirname,'../dsh/send_to_gpt.cjs'),file);
 const {execute}=require(file),req={text:m.body,waitSeconds:0};
 const first=await execute(req,m.origin),again=await execute(req,m.origin);
 assert.equal(first.messageId,again.messageId);
 const packetFile=state.read(path.join(c.spoolRoot,'dsh-to-gpt',first.messageId+'.json'));
 const h=history(packetFile,es=>es[2].data.arguments=JSON.stringify({text:m.body}));
 assert.equal((await verifyDSHSource(packetFile,c,dependencies(packetFile,h))).verified,true);
 assert.equal((await verifyDSHSource({...packetFile,messageId:'dsh-forged-extra'},c,dependencies(packetFile,h))).verified,false);
});
test.after(()=>{const actual=fs.realpathSync(root);assert.ok(actual.toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase()+path.sep));assert.ok(path.basename(actual).startsWith('peer-source-test-'));fs.rmSync(actual,{recursive:true,force:true});});
