'use strict';
require('./config.cjs').applyEnvironment();
// Both desktops use this local control service. App connection details stay in memory.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const {home,pipe,alive}=require('./channel-ipc.cjs');
const {CodexClient}=require('./codex-client.cjs');
const {ChannelManager}=require('./channel-manager.cjs');
const state=require('./peer-dialogue-state.cjs');
const relayHome=require('./config.cjs').statePath('harness-event-relay');
function discoverPipes(){
 const script="@([IO.Directory]::GetFiles('\\\\.\\pipe\\') | Where-Object { [IO.Path]::GetFileName($_) -match '^codex-browser-use-[0-9a-f-]+$' }) | ConvertTo-Json -Compress";
 const raw=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:15000}).trim();
 const pipes=raw?[JSON.parse(raw)].flat():[];
 if(!pipes.length)throw Error('Open Codex Desktop before starting the listener');
 const preferred=process.env.CODEX_APP_TOOLS_PIPE_PATH;return preferred&&pipes.includes(preferred)?[preferred,...pipes.filter(p=>p!==preferred)]:pipes;
}
function discoverPipe(){const pipes=discoverPipes();if(pipes.length!==1&&!process.env.CODEX_APP_TOOLS_PIPE_PATH)throw Error('Multiple desktop connections require native identity verification');return pipes[0];}
async function connectAuthorizedApp(policy){
 let last;
 for(const pipePath of discoverPipes()){
  const client=new CodexClient({callerThreadId:policy.controlThreadId,pipePath});
  try{await client.start();const result=await client.tool('read_thread',{threadId:policy.controlThreadId,turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:250});const value=require('./channel-manager.cjs').toolValue(result);if(!JSON.stringify(value).includes(policy.controlThreadId))throw Error('Native app did not confirm the registered actual control chat');return {client,pipePath};}catch(e){last=e;client.close();}
 }
 throw last||Error('No native Codex connection can confirm the authorized control chat');
}
function relayStatus(){const s=state.read(path.join(relayHome,'status.json'),{state:'not-started'});return {...s,processExists:!!s.pid&&alive(s.pid)};}
async function main(){
 const lock=path.join(home,'channel-service.lock'),fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),inheritedCodexThread:!!process.env.CODEX_THREAD_ID,inheritedCodexPipe:!!process.env.CODEX_APP_TOOLS_PIPE_PATH}));
 const policy=state.read(path.join(home,'channel-policy.json'));let client,appPipe;
 function discardApp(){client?.close();client=null;}
 async function app(){if(client?.child&&client.child.exitCode!==null)discardApp();if(!client){const connected=await connectAuthorizedApp(policy);client=connected.client;appPipe=connected.pipePath;}return client;}
 const appProxy={tool:async(name,args)=>{try{return await(await app()).tool(name,args);}catch(e){discardApp();throw e;}}};
 async function healthyApp(){try{await(await app()).tool('list_threads',{limit:1});}catch{discardApp();await(await app()).tool('list_threads',{limit:1});}return crypto.createHash('sha256').update(appPipe).digest('hex').slice(0,16);}
 function auditDeliveries(){for(const dir of [path.join(relayHome,'deliveries'),path.join(home,'deliveries')])for(const name of fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>n.endsWith('.json')):[]){if(['sending','reserved','uncertain'].includes(state.read(path.join(dir,name)).status))throw Error('An unconfirmed delivery requires review; no automatic replay or lock removal');}}
 async function ensureListener(start){
  let status=relayStatus();if(!start)return status;
  const connectionId=await healthyApp();
  if(status.processExists&&status.state!=='stopped'){
   if(status.codexConnectionId===connectionId)return status;
   auditDeliveries();state.atomic(path.join(relayHome,'stop.request'),{reason:'authorized-common-entry-refreshes-desktop-connection',time:new Date().toISOString()});
   const until=Date.now()+10000;while(Date.now()<until){status=relayStatus();if(!status.processExists||status.state==='stopped')break;await new Promise(r=>setTimeout(r,150));}
   if(status.processExists&&status.state!=='stopped')throw Error('Existing listener did not close; do not start a duplicate');
  }
  const relayLock=path.join(relayHome,'relay.lock');
  if(fs.existsSync(relayLock)){
   const old=state.read(relayLock);if(alive(old.pid))throw Error('Recorded relay process still exists; inspect it before starting another');
   auditDeliveries();
   fs.renameSync(relayLock,relayLock+'.audited-'+Date.now());
  }
  fs.mkdirSync(relayHome,{recursive:true});
  const exe=require('./config.cjs').settings().dshExe;
  const output=fs.openSync(require('./config.cjs').statePath('event-relay.stdout.log'),'a'),error=fs.openSync(require('./config.cjs').statePath('event-relay.stderr.log'),'a');
  const child=spawn(exe,['--expose-internals',path.join(__dirname,'event-relay.cjs')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',CODEX_APP_TOOLS_PIPE_PATH:appPipe,HARNESS_CONTROLLER_THREAD_ID:policy.controlThreadId},cwd:path.resolve(__dirname,'../..'),windowsHide:true,detached:true,stdio:['ignore',output,error]});child.unref();fs.closeSync(output);fs.closeSync(error);
  const deadline=Date.now()+20000;
  while(Date.now()<deadline){const next=relayStatus();if(next.pid===child.pid&&next.processExists&&['listening','connecting'].includes(next.state))return next;if(next.pid===child.pid&&next.state==='stopped')throw Error('Listener did not start: '+next.reason);await new Promise(r=>setTimeout(r,150));}
  throw Error('Listener start has not been confirmed; inspect its status before retrying');
 }
 async function logFor(threadId){
  const deadline=Date.now()+20000;let last;
  while(Date.now()<deadline){try{const root=path.join(require('./config.cjs').settings().codexHome,'sessions'),matches=[];const walk=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.isSymbolicLink())continue;const file=path.join(dir,e.name);if(e.isDirectory())walk(file);else if(e.name.endsWith(threadId+'.jsonl'))matches.push(file);}};walk(root);if(matches.length!==1)throw Error('Actual Codex chat log is not ready');return require('./peer-auto-dialogue.cjs').verifyLog(matches[0],threadId,require('./peer-auto-dialogue.cjs').metadata(matches[0]).cwd);}catch(e){last=e;await new Promise(r=>setTimeout(r,150));}}
  throw last;
 }
 const {Harness}=require('./bridge.cjs');let harness,harnessAt=0;
 function currentHarness(){if(!harness||Date.now()-harnessAt>240000){harness=new Harness();harnessAt=Date.now();}return harness;}
 const harnessProxy={list:async()=>currentHarness().list(),history:async(...args)=>currentHarness().history(...args),call:async(...args)=>currentHarness().call(...args)};
 const manager=new ChannelManager({harness:harnessProxy,client:appProxy,ensureListener,logFor,spoolRoot:policy.spoolRoot,policy});
 const server=net.createServer(socket=>{let buffer='';socket.on('error',()=>{});socket.on('data',chunk=>{buffer+=chunk;if(buffer.length>256000){socket.destroy();return;}const end=buffer.indexOf('\n');if(end<0)return;const raw=buffer.slice(0,end);buffer='';let req;try{req=JSON.parse(raw);}catch{socket.end(JSON.stringify({ok:false,error:'Invalid channel request'})+'\n');return;}
   Promise.resolve(req.command==='ping'?{pid:process.pid,version:2}:manager.run(req)).then(result=>socket.end(JSON.stringify({ok:true,result})+'\n'),e=>socket.end(JSON.stringify({ok:false,error:e.message})+'\n'));
  });});
 server.listen(pipe,()=>console.log(JSON.stringify({pid:process.pid,version:2,state:'ready'})));
 const close=()=>{client?.close();server.close();try{fs.closeSync(fd);fs.unlinkSync(lock);}catch{}process.exit(0);};process.once('SIGTERM',close);process.once('SIGINT',close);
 server.on('error',e=>{console.error(e.message);close();});
}
module.exports={discoverPipe,discoverPipes,connectAuthorizedApp,relayStatus,main};
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
