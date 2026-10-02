'use strict';
require('./config.cjs').applyEnvironment();
// Uses the installed Codex app-tools MCP server. No private credentials persisted.
const {spawn}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');
const THREAD=null;
class CodexClient {
 constructor({callerThreadId,pipePath}={}){this.pending=new Map();this.seq=0;this.buffer='';this.caller=callerThreadId||process.env.CODEX_THREAD_ID||process.env.HARNESS_CONTROLLER_THREAD_ID||THREAD;this.pipePath=pipePath;}
 async start(){
  if(!require('./routing.cjs').validThread(this.caller))throw Error('An actual authorized Codex caller is required');
  const pipePath=this.pipePath||process.env.CODEX_APP_TOOLS_PIPE_PATH;
  if(!pipePath)throw Error('Start this relay from the authorized Codex chat; app-tools connection is missing.');
  const server=require('./config.cjs').discoverAppTools();
  if(!fs.existsSync(server))throw Error('Codex app-tools version changed; revalidate the relay.');
  const node=require('./config.cjs').settings().nodePath;
  this.child=spawn(node,[server],{env:{...process.env,CODEX_APP_TOOLS_PIPE_PATH:pipePath},windowsHide:true,stdio:['pipe','pipe','pipe']});
  this.child.on('error',e=>this.fail(e));
  this.child.on('exit',()=>this.fail(Error('Codex MCP server closed')));
  this.child.stderr.on('data',()=>{});
  this.child.stdout.on('data',chunk=>{
   this.buffer+=chunk;let n;
   while((n=this.buffer.indexOf('\n'))>=0){
    const line=this.buffer.slice(0,n);this.buffer=this.buffer.slice(n+1);
    try{const r=JSON.parse(line),p=this.pending.get(r.id);if(p){this.pending.delete(r.id);clearTimeout(p.timer);r.error?p.reject(Error(r.error.message)):p.resolve(r.result);}}catch(e){this.fail(e);}
   }
  });
  await this.call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'authorized-dsh-codex-relay',version:'0.1.0'}});
  this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const catalog=await this.call('tools/list',{});this.catalog=catalog.tools;
  if(!catalog.tools.some(t=>t.name==='send_message_to_thread'))throw Error('Codex chat delivery tool is unavailable');
 }
 call(method,params){return new Promise((resolve,reject)=>{
  const id=++this.seq;
  const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Codex MCP request timed out; delivery may be uncertain'));},20000);
  this.pending.set(id,{resolve,reject,timer});
  this.child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n',e=>{if(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});
 });}
 async send(prompt,threadId){
  if(!require('./routing.cjs').validThread(threadId))throw Error('Invalid target chat');
  return this.tool('send_message_to_thread',{threadId,prompt});
 }
 async tool(name,args={}){
  if(this.catalog&&!this.catalog.some(t=>t.name===name))throw Error('Codex app tool is unavailable: '+name);
  const r=await this.call('tools/call',{name,arguments:args,_meta:{'openai/threadId':this.caller}});
  if(r.isError)throw Error(r.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')||'Codex app tool failed');
  return r;
 }
 fail(e){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e);}this.pending.clear();}
 close(){this.child?.stdin.end();this.child?.kill();}
}
module.exports={CodexClient,THREAD};
