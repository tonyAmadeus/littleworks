'use strict';
require('./config.cjs').applyEnvironment();
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const DEFAULT_THREAD=null;
const home=process.env.HARNESS_ROUTING_STATE||require('./config.cjs').statePath('harness-routing');
const file=path.join(home,'state.json');
function validThread(id){return typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);}
function read(){let s;try{s=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;s={version:1,sequence:0,current:{threadId:DEFAULT_THREAD,sequence:0},tasks:{}};}
 s.mode??='latest';s.groups??={};return s;}
async function mutate(fn){
 fs.mkdirSync(home,{recursive:true});const lock=path.join(home,'routing.lock');let fd;
 for(let n=0;;n++){try{fd=fs.openSync(lock,'wx');break;}catch(e){if(e.code!=='EEXIST'||n>=60)throw e;await new Promise(r=>setTimeout(r,50));}}
 try{const s=read(),result=fn(s);const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(s,null,2));fs.renameSync(tmp,file);return result;}finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
async function prepare(req,job){
 if(job.routing)return job.routing;
 if(req.returnToCodex===false||job.taskId.startsWith('mailbox-reply-'))return null;
 const threadId=process.env.CODEX_THREAD_ID;
 if(!validThread(threadId))throw Error('Cannot identify originating Codex chat. Invoke from Codex or set returnToCodex:false for a non-routing transport request.');
 return mutate(s=>{if(s.mode==='groups'&&s.groups[job.sessionId]?.threadId!==threadId)throw Error('This DSH chat is unbound or bound to another Codex chat. Explicitly bind a group or choose the correct DSH chat.');return {threadId,sequence:++s.sequence,cwd:process.cwd(),createdAt:new Date().toISOString(),forwardReply:req.replyChannel!=='peer'&&!require('./command-prefix.cjs').isUserCommand(req.text)};});
}
async function commit(job){
 if(!job.routing)return;
 return mutate(s=>{
  if(!s.tasks[job.taskId])s.tasks[job.taskId]={taskId:job.taskId,sessionId:job.sessionId,originThreadId:job.routing.threadId,sequence:job.routing.sequence,forwardReply:job.routing.forwardReply,finished:!job.routing.forwardReply};
  if(job.routing.sequence>s.current.sequence)s.current={...job.routing,sessionId:job.sessionId,taskId:job.taskId,committedAt:new Date().toISOString()};
 });
}
async function finish(taskId){return mutate(s=>{if(s.tasks[taskId])s.tasks[taskId].finished=true;});}
function target(sessionId){const s=read(),t=s.mode==='groups'?s.groups[sessionId]?.threadId:s.current.threadId;if(!validThread(t))throw Error('No valid return target for DSH chat '+sessionId);return t;}
async function setMode(mode){if(!['latest','groups'].includes(mode))throw Error('mode must be latest or groups');return mutate(s=>{if(mode==='groups'){const pending=Object.values(s.tasks).filter(t=>!t.finished&&!s.groups[t.sessionId]);if(pending.length)throw Error('Bind groups for outstanding tasks before switching mode');}s.mode=mode;return s;});}
async function bind(sessionId,threadId,name,receiveCommands=false){
 if(!/^[-a-zA-Z0-9_]{1,160}$/.test(sessionId)||!validThread(threadId))throw Error('Valid sessionId and Codex threadId required');
 return mutate(s=>{s.groups[sessionId]={threadId,name:name||sessionId,receiveCommands,updatedAt:new Date().toISOString()};return s.groups[sessionId];});
}
module.exports={read,prepare,commit,finish,target,home,validThread,setMode,bind};
