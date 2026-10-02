'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-route-test-'));process.env.HARNESS_ROUTING_STATE=temp;
const routing=require('./routing.cjs');
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test('latest initiated successful send wins, even if older request completes late; retry/receipt do not steal target',async()=>{
 process.env.CODEX_THREAD_ID=A;
 const a={taskId:'a',sessionId:'s'};a.routing=await routing.prepare({text:'first'},a);
 process.env.CODEX_THREAD_ID=B;
 const b={taskId:'b',sessionId:'s'};b.routing=await routing.prepare({text:'second'},b);
 await routing.commit(b);await routing.commit(a);assert.equal(routing.target(),B);
 await routing.commit(a);assert.equal(routing.target(),B);
 process.env.CODEX_THREAD_ID=A;
 assert.equal(await routing.prepare({text:'receipt',returnToCodex:false},{taskId:'receipt'}),null);
 assert.equal(await routing.prepare({text:'receipt'},{taskId:'mailbox-reply-abc'}),null);
 assert.equal(routing.target(),B);
 const c={taskId:'c',sessionId:'s'};c.routing=await routing.prepare({text:'third'},c);
 assert.equal(routing.target(),B,'unaccepted send must not change target');
 await routing.commit(c);assert.equal(routing.target(),A);
});
test('MCP delivery uses selected destination rather than original fixed thread',async()=>{
 const {CodexClient}=require('./codex-client.cjs');const c=new CodexClient();let captured;
 c.call=async(method,params)=>{captured=params;return {content:[]};};
 await c.send('test',B);assert.equal(captured.arguments.threadId,B);assert.equal(captured._meta['openai/threadId'],A);
 await assert.rejects(c.send('test','invalid'));
});
test('prefixed user commands route but suppress DSH acknowledgement echo',async()=>{
 const j={taskId:'command'};j.routing=await routing.prepare({text:'给Codex：check'},j);assert.equal(j.routing.forwardReply,false);
});
test('groups keep independent destinations; unrelated sender cannot take a fixed group',async()=>{
 await routing.bind('s',A,'group A');await routing.bind('t',B,'group B');await routing.setMode('groups');
 assert.equal(routing.target('s'),A);assert.equal(routing.target('t'),B);
 process.env.CODEX_THREAD_ID=B;const j={taskId:'group-b',sessionId:'t'};j.routing=await routing.prepare({text:'group message'},j);await routing.commit(j);
 assert.equal(routing.target('s'),A);assert.equal(routing.target('t'),B);
 await assert.rejects(routing.prepare({text:'wrong group'},{taskId:'wrong',sessionId:'s'}));
 assert.throws(()=>routing.target('unbound'));
 await routing.setMode('latest');assert.equal(routing.target('s'),B);assert.equal(routing.target('t'),B);
});
test.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
