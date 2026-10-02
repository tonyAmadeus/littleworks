#!/usr/bin/env node
'use strict';
require('./config.cjs').applyEnvironment();
// Local adapter for DeepSeek Harness Desktop 0.2.0-rc.2. No external dependencies.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const root=path.join(path.dirname(process.execPath),'resources','app.asar','dsh','node_modules');
const YAML=require(path.join(root,'yaml'));
const WS=require(path.join(root,'ws'));
const stateDir=process.env.HARNESS_BRIDGE_STATE || require('./config.cjs').statePath('harness-bridge-state');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function fail(code,message){const e=new Error(message);e.code=code;throw e;}
function id(value,label='sessionId'){if(typeof value!=='string'||!/^[-a-zA-Z0-9_]{1,160}$/.test(value))fail('invalid_input','Invalid '+label);return value;}
function save(job){fs.mkdirSync(stateDir,{recursive:true});const dest=path.join(stateDir,id(job.taskId,'taskId')+'.json');const tmp=dest+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(job,null,2));fs.renameSync(tmp,dest);}
function load(taskId){return JSON.parse(fs.readFileSync(path.join(stateDir,id(taskId,'taskId')+'.json'),'utf8'));}
function discover(){
 const script="$pids = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id); @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' -and $_.OwningProcess -in $pids } | Select-Object -ExpandProperty LocalPort -Unique) | ConvertTo-Json -Compress";
 const raw=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:15000}).trim();
 if(!raw)fail('harness_not_running','Open DeepSeek Harness Desktop first.');
 const ports=[JSON.parse(raw)].flat();
 if(ports.length!==1)fail('ambiguous_host','Expected one Harness loopback listener; found '+ports.length);
 return 'http://127.0.0.1:'+ports[0];
}
class Harness {
 constructor(){
  this.version=require(path.resolve(root,'../../package.json')).version;
  if(this.version!=='0.2.0-rc.2')fail('unsupported_version','Harness version changed to '+this.version+'. Revalidate the adapter before use.');
  this.origin=discover();
  const home=process.env.DSH_HOME?.trim()||path.join(process.env.USERPROFILE,'.dsh');
  const doc=YAML.parse(fs.readFileSync(path.join(home,'.credentials.yaml'),'utf8'));
  const record=doc.records?.['client-connection/browser-session'];
  if(record?.kind!=='grant'||record.payload?.version!==1)fail('auth_format_changed','Unsupported Harness local browser-session credential.');
  const secret=Buffer.from(record.payload.secret,'base64url');
  if(secret.length!==32)fail('auth_format_changed','Invalid local browser-session credential.');
  const authority=new URL(this.origin).host,now=Date.now();
  // Five-minute authority-bound credential stays in memory. Never persist or print it.
  const body=Buffer.from(JSON.stringify({version:1,authority,issuedAt:now,expiresAt:now+300000})).toString('base64url');
  this.cookie='dsh-auth-'+crypto.createHash('sha256').update(authority).digest('base64url')+'=v1.'+body+'.'+crypto.createHmac('sha256',secret).update(body).digest('base64url');
 }
 async call(method,args={}){
  const rpcId=crypto.randomUUID();
  const r=await fetch(this.origin+'/api/'+method,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',Origin:this.origin,Cookie:this.cookie},body:JSON.stringify({type:'client-request',rpcId,method,payload:{args}})});
  if(!r.ok)fail('http_'+r.status,'Harness returned HTTP '+r.status);
  const j=await r.json();
  if(j.type!=='server-response'||j.rpcId!==rpcId)fail('protocol_changed','Unexpected RPC envelope');
  if(!j.result?.ok)fail(j.result?.error?.code||'rpc_error',j.result?.error?.message||'Harness RPC failed');
  return j.result.value;
 }
 async list(){return (await this.call('session/list',{_request:{}})).items;}
 follow(sessionId,onFrame,seconds=0){
  id(sessionId);return new Promise((resolve,reject)=>{
   const streamId=crypto.randomUUID();let snapshot,finished=false;
   const ws=new WS(this.origin.replace('http:','ws:')+'/api/remote.mux',{headers:{Origin:this.origin,Cookie:this.cookie},maxPayload:32*1024*1024});
   const timer=setTimeout(()=>finish(snapshot?undefined:new Error('Follow snapshot timed out')),seconds?seconds*1000:15000);
   function finish(error){if(finished)return;finished=true;clearTimeout(timer);ws.close();error?reject(error):resolve(snapshot);}
   ws.on('open',()=>ws.send(JSON.stringify({type:'open',streamId,endpoint:'session/follow',payload:{args:{request:{address:{kind:'session',sessionId},assistantStream:true,maxMessages:50}}}})));
   ws.on('message',raw=>{try{const f=JSON.parse(raw);if(f.streamId!==streamId)return;if(f.type==='error')return finish(new Error(JSON.stringify(f.error)));if(f.type==='item'){if(f.value.type==='snapshot')snapshot=f.value;onFrame?.(f.value);if(snapshot&&!seconds)finish();}}catch(e){finish(e);}});
   ws.on('error',finish);ws.on('close',()=>{if(!finished)finish(new Error('Harness stream closed before completion'));});
  });
 }
 async history(sessionId,{maxPages=20,beforeSeq}={}){
  const s=await this.follow(sessionId);let records=s.records,hasMore=s.hasMore,pages=1;
  if(beforeSeq!==undefined){const p=await this.call('session/page',{request:{address:{kind:'session',sessionId},throughSeq:s.cursor,beforeSeq,maxMessages:100}});records=p.records;hasMore=p.hasMore;}
  while(hasMore&&pages<Math.min(100,Math.max(1,maxPages))){const before=records[0]?.event?.seq;if(before===undefined)break;const p=await this.call('session/page',{request:{address:{kind:'session',sessionId},throughSeq:s.cursor,beforeSeq:before,maxMessages:100}});if(!p.records.length)break;records=[...p.records,...records];hasMore=p.hasMore;pages++;}
  return {sessionId,header:s.header,cursor:s.cursor,records,hasMore,nextBeforeSeq:hasMore?records[0]?.event?.seq:null,projections:s.projections?.values||{}};
 }
}
function textContent(content){return (content||[]).filter(p=>p.type==='text').map(p=>p.text).join('');}
function messages(records){return records.map(r=>r.event).filter(e=>['user/message','assistant/message'].includes(e.type)).map(e=>({seq:e.seq,time:e.time,role:e.type.split('/')[0],turn:e.data.turn,requestId:e.data.source?.rpcId,text:textContent(e.data.message?.content||e.data.content),surfaceOp:e.surfaceOp,attachments:(e.data.message?.content||e.data.content||[]).filter(x=>!['text','reasoning'].includes(x.type)).map(x=>({type:x.type})),...(e.type==='assistant/message'?{usage:e.data.usage}: {})}));}
function summarize(s){const p=s.projections?.values||{};return {sessionId:s.sessionId,title:p.title,workingDirectory:s.cwd,running:s.running,blank:s.blank,model:p.modelSelection,usage:p.tokenUsage};}
async function taskStatus(h,job){
 const hist=await h.history(job.sessionId);const es=hist.records.map(r=>r.event);const u=es.find(e=>e.type==='user/message'&&e.data.source?.rpcId===job.requestId);
 const start=u?es.filter(e=>e.seq<u.seq&&e.type==='turn/start').at(-1):undefined;
 const turn=start?.data.turn;const end=turn===undefined?undefined:es.find(e=>e.type==='turn/end'&&e.data.turn===turn);
 const outputs=turn===undefined?[]:messages(hist.records).filter(m=>m.role==='assistant'&&m.turn===turn);
 const inbox=hist.projections.inbox||{};const queued=Object.values(inbox).flat().some(m=>m?.source?.rpcId===job.requestId);
 const activeQuestions=hist.projections.userQuestions?.active||[];
 const reason=end?.data.reason;
 let status=end?(reason?.kind==='completed'?'completed':['cancelled','interrupted'].includes(reason?.kind)||(reason?.kind==='aborted'&&reason.reason?.kind==='user')?'cancelled':'failed'):u?'running':queued?'queued':'unconfirmed';
 if(!end&&activeQuestions.length)status='awaiting_user';
 const result={taskId:job.taskId,sessionId:job.sessionId,requestId:job.requestId,status,turn,reason:end?.data.reason,finalText:outputs.at(-1)?.text||'',messages:outputs,questions:activeQuestions,historyTruncated:hist.hasMore,usage:hist.projections.tokenUsage};
 save({...job,lastStatus:status,updatedAt:new Date().toISOString()});return result;
}
async function execute(req){
 if(!req||typeof req!=='object')fail('invalid_input','Expected a JSON request');
 if(req.command==='send-addressed'){
  const parsed=require('./dsh-command-prefix.cjs').parseDSHCommand(req.text);
  if(!parsed)fail('invalid_input','Expected an explicitly addressed DSH task with a nonempty body');
  req={...req,command:'send',text:parsed.text};
 }
 const h=new Harness();
 switch(req.command){
  case 'health': return {connected:true,origin:h.origin,version:h.version,sessions:(await h.list()).map(summarize)};
  case 'list': return {sessions:(await h.list()).map(summarize)};
  case 'create': {
   if(!req.cwd||!path.isAbsolute(req.cwd)||!fs.statSync(req.cwd).isDirectory())fail('invalid_input','create requires an existing absolute cwd directory');
   const c=await h.call('session/create',{request:{cwd:req.cwd,...(req.sessionId?{sessionId:id(req.sessionId)}:{})}});
   if(req.title)await h.call('session/rename',{request:{sessionId:c.sessionId,title:req.title}});
   return {...c,title:req.title,cwd:req.cwd};
  }
  case 'read': {const v=await h.history(id(req.sessionId),req);return {sessionId:v.sessionId,cursor:v.cursor,title:v.projections.title,messages:messages(v.records),hasMore:v.hasMore,nextBeforeSeq:v.nextBeforeSeq};}
  case 'send': {
   const sessionId=id(req.sessionId);if(typeof req.text!=='string'||!req.text.trim())fail('invalid_input','send requires non-empty text');
   if(req.replyChannel!==undefined&&req.replyChannel!=='peer')fail('invalid_input','replyChannel must be peer when provided');
   if(req.mode!==undefined&&!['queue','steer'].includes(req.mode))fail('invalid_input','mode must be queue or steer');
   const taskId=id(req.taskId||'task-'+crypto.randomUUID(),'taskId');const digest=crypto.createHash('sha256').update(JSON.stringify({sessionId,text:req.text,mode:req.mode||'queue',...(req.replyChannel?{replyChannel:req.replyChannel}:{})})).digest('hex');
   let job;try{job=load(taskId);}catch(e){if(e.code!=='ENOENT')throw e;}
   if(job&&job.digest!==digest)fail('task_conflict','taskId already belongs to a different message');
   if(job?.accepted){await require('./routing.cjs').commit(job);return {taskId,sessionId,requestId:job.requestId,accepted:true,reused:true};}
   const summary=(await h.list()).find(s=>s.sessionId===sessionId);if(!summary)fail('session_not_found','Unknown session');
   if(summary.running&&!req.mode)fail('session_busy','Session is running. Wait, or explicitly choose mode queue/steer.');
   job=job||{taskId,sessionId,requestId:crypto.randomUUID(),digest,text:req.text,mode:req.mode||'queue',harnessCwd:summary.cwd,createdAt:new Date().toISOString()};
   job.routing=await require('./routing.cjs').prepare(req,job);save(job);
   const result=await h.call('session/prompt',{request:{sessionId,requestId:job.requestId,mode:job.mode,clientTimeZone:'Asia/Shanghai',content:[{type:'text',text:req.text}]}});
   job={...job,accepted:result.accepted};save(job);if(result.accepted)await require('./routing.cjs').commit(job);return {taskId,sessionId,requestId:job.requestId,...result,...job.routing?{returnRouting:require('./routing.cjs').read().mode,originThreadId:job.routing.threadId}:{}};
  }
  case 'status': return taskStatus(h,load(req.taskId));
  case 'wait': {
   const job=load(req.taskId),deadline=Date.now()+Math.min(55,Math.max(0,req.seconds??50))*1000;let result;
   do{result=await taskStatus(h,job);if(['completed','failed','cancelled','awaiting_user'].includes(result.status))return result;if(Date.now()<deadline)await delay(Math.min(2000,deadline-Date.now()));}while(Date.now()<deadline);
   return {...result,timedOut:true};
  }
  case 'cancel': {const job=load(req.taskId);const before=await taskStatus(h,job);if(['completed','failed','cancelled'].includes(before.status))return {...before,alreadySettled:true};if(req.scope!=='session')fail('scope_required','Cancellation affects the whole Harness session. Set scope=session explicitly.');return {taskId:job.taskId,sessionId:job.sessionId,...await h.call('session/cancel',{request:{sessionId:job.sessionId}})};}
  case 'watch': {
   const frames=[];await h.follow(id(req.sessionId),f=>{if(f.type==='snapshot')frames.push({type:f.type,cursor:f.cursor,messages:messages(f.records)});else {const e=f.event||f.record?.event;if(e&&['user/message','assistant/message','turn/start','turn/end'].includes(e.type))frames.push({type:e.type,seq:e.seq,messages:messages([{event:e}]),reason:e.type==='turn/end'?e.data.reason:undefined});}},Math.min(55,Math.max(1,req.seconds??10)));return {sessionId:req.sessionId,frames};
  }
  default: fail('invalid_command','Commands: health, list, create, read, send, send-addressed, status, wait, cancel, watch');
 }
}
module.exports={Harness,execute,messages,taskStatus};
if(require.main===module)(async()=>{
 const fileIndex=process.argv.indexOf('--request');const raw=fileIndex>=0?fs.readFileSync(process.argv[fileIndex+1],'utf8'):fs.readFileSync(0,'utf8');
 const result=await execute(JSON.parse(raw.replace(/^\uFEFF/,'')));console.log(JSON.stringify({ok:true,...result},null,2));
})().catch(e=>{console.log(JSON.stringify({ok:false,error:{code:e.code||'bridge_error',message:e.message}}));process.exitCode=1;});
