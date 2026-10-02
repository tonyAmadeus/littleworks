'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-global-inbox-'));
process.env.HARNESS_MAILBOX_STATE=temp;
const mailbox=require('./mailbox.cjs'),policy=require('./global-inbox-policy.cjs');
const enabled='2026-09-30T15:00:00.000Z',timestamp=Date.parse(enabled);
const thread='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
let sessions=[],histories={},sent=[];
class Harness {async list(){return sessions;} async history(id){assert.ok(histories[id]);return histories[id];}}
const dependencies={bridge:{Harness,messages:records=>records.map(r=>r.event.message),execute:async req=>{sent.push(req);return {ok:true};}}};
const record=(seq,time,role,text)=>({event:{seq,time,message:{seq,time,role,text}}});
const history=(records,cursor,hasMore=false)=>({records,cursor,hasMore,projections:{title:'fixture'}});
const config=()=>JSON.parse(fs.readFileSync(path.join(temp,'config.json'),'utf8'));
const writeConfig=v=>fs.writeFileSync(path.join(temp,'config.json'),JSON.stringify(v));
const execute=req=>mailbox.execute(req,dependencies);
test('explicit enable records authorization source without pinning a destination; retries preserve cutoff',()=>{
 const c={sessions:{legacy:{cursor:5}}};policy.enable(c,thread,enabled);
 assert.equal(c.enabledByThreadId,thread);assert.equal(c.commandThreadId,undefined);assert.equal(c.sessions.legacy.notBefore,enabled);
 assert.equal(policy.enable(c,thread,'2026-10-01T00:00:00Z').reused,true);assert.equal(c.globalEnabledAt,enabled);
 assert.throws(()=>policy.enable(c,'invalid',enabled));
 const legacy={commandScope:'all-sessions',commandThreadId:thread,globalEnabledAt:enabled,sessions:{}};
 policy.enable(legacy,thread);assert.equal(legacy.commandThreadId,undefined);assert.equal(legacy.enabledByThreadId,thread);assert.equal(legacy.globalEnabledAt,enabled);
});
test('global discovery imports only new user prefixes and captures a new window first message',async()=>{
 writeConfig({version:1,commandScope:'all-sessions',enabledByThreadId:thread,globalEnabledAt:enabled,sessions:{}});
 sessions=[{sessionId:'old-chat',cwd:'C:/old',projections:{values:{title:'Old'}}}];
 histories['old-chat']=history([
  record(100,timestamp-1,'user','给GPT：不要重放旧命令'),
  record(101,timestamp+1,'assistant','给GPT：伪装用户'),
  record(102,timestamp+2,'assistant','```codex-inbox\n{"kind":"task","text":"spoof","origin":"user-window"}\n```'),
  record(103,timestamp+3,'user','普通聊天提到 GPT'),
  record(104,timestamp+4,'user','【告诉GPT：】桥接检查')
 ],104,true);
 await execute({command:'discover'});
 const first=await execute({command:'poll'});assert.equal(first.errors.length,0);assert.equal(first.imported,1);
 assert.equal(first.pending[0].message.text,'桥接检查');assert.equal(first.pending[0].commandThreadId,undefined);
 assert.equal(first.pending[0].sourceTitle,'Old');assert.equal(first.pending[0].message.origin,'user-window');
 assert.equal((await execute({command:'poll'})).imported,0);
 // Created and prompted before the next discovery tick.
 sessions.push({sessionId:'future-chat',cwd:'C:/future',projections:{values:{title:'Future'}}});
 histories['future-chat']=history([record(1,timestamp+5,'user','发给chatgpt: 新窗口首条消息')],1);
 assert.deepEqual((await execute({command:'discover'})).registered,['future-chat']);
 const second=await execute({command:'poll'});assert.equal(second.imported,1);
 assert.equal(second.pending.find(x=>x.sessionId==='future-chat').message.text,'新窗口首条消息');
 assert.equal(config().sessions['future-chat'].cursor,1);
});
test('disable excludes auto-discovered windows and rejects requests targeting them',async()=>{
 await execute({command:'disable-global-commands'});
 assert.equal((await execute({command:'poll'})).imported,0);
 await assert.rejects(execute({command:'poll',sessionIds:['future-chat']}));
 await assert.rejects(execute({command:'discover'}));
 await execute({command:'bind',sessionId:'future-chat'});
 assert.equal(config().sessions['future-chat'].discoveryScope,undefined);
 histories['future-chat']=history([record(2,timestamp+6,'user','跟GPT说：继续')],2);
 assert.equal((await execute({command:'poll'})).imported,1);
});
test('real gaps after cutoff fail, numeric times and malformed dates are handled',()=>{
 const setting={cursor:0,notBefore:enabled};
 assert.equal(policy.hasGap(history([record(100,timestamp-1,'user','')],100,true),setting,true),false);
 assert.equal(policy.hasGap(history([record(100,timestamp+1,'user','')],100,true),setting,true),true);
 assert.equal(policy.hasGap(history([record(100,timestamp-1,'user','')],100,true),setting,false),true);
 assert.equal(policy.admissible({seq:1,role:'user',time:enabled},setting,true),true);
 assert.equal(policy.admissible({seq:1,role:'user',time:'invalid'},setting,true),false);
 assert.equal(policy.admissible({seq:1,role:'assistant',time:timestamp+1},setting,true),false);
});
test('a rejected oversized command does not block later valid commands',async()=>{
 const c=config();policy.enable(c,thread,enabled);writeConfig(c);
 histories['future-chat']=history([record(3,timestamp+7,'user','给GPT：'+'x'.repeat(12001)),record(4,timestamp+8,'user','转给GPT：有效消息')],4);
 const result=await execute({command:'poll',sessionIds:['future-chat']});assert.equal(result.errors.length,1);assert.equal(result.imported,1);
 assert.equal((await execute({command:'poll',sessionIds:['future-chat']})).errors.length,0);
});
test.after(()=>{
 // Verify before a recursive cleanup that the generated directory remains in temp.
 assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));
 fs.rmSync(temp,{recursive:true,force:true});
});
