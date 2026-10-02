'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync,execFileSync}=require('node:child_process');
const config=require('./runtime/config.cjs');
const START='# BEGIN CODEX-DSH-BRIDGE',END='# END CODEX-DSH-BRIDGE';
const validThread=x=>typeof x==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(x);
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
function atomic(file,value){require('./runtime/atomic-json.cjs').atomic(file,value);}
function text(file){return fs.existsSync(file)?fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''):'';}
function removeBlock(value){
 const a=value.indexOf(START),b=value.indexOf(END);
 if(a<0&&b<0)return value;
 if(a<0||b<a||value.indexOf(START,a+START.length)>=0||value.indexOf(END,b+END.length)>=0)throw Error('Invalid managed block; preserve the original file for review');
 return value.slice(0,a)+value.slice(b+END.length).replace(/^\r?\n/,'');
}
function putBlock(value,body){return removeBlock(value).trimEnd()+'\n\n'+START+'\n'+body+'\n'+END+'\n';}
function profileCall(c,request){
 const r=spawnSync(c.dshExe,['--expose-internals',path.join(config.packageRoot,'profile.cjs')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},input:JSON.stringify(request),encoding:'utf8',windowsHide:true,timeout:25000});
 if(r.error)throw r.error;let result;try{result=JSON.parse(r.stdout.trim());}catch{throw Error('Cannot inspect the DSH runtime: '+(r.stderr||'no response').slice(0,400));}
 if(!result.ok)throw Error(result.error);return result.result;
}
function plan(c=config.settings()){
 const exists=x=>typeof x==='string'&&fs.existsSync(x);let server,error;
 try{server=config.discoverAppTools(c);}catch(e){error=e.message;}
 return {packageVersion:'0.1.0',platform:process.platform,nodeVersion:process.version,
  installationRoot:config.packageRoot,stateRoot:c.stateRoot,codexHome:c.codexHome,dshHome:c.dshHome,
  checks:{windows:process.platform==='win32',node22OrNewer:Number(process.versions.node.split('.')[0])>=22,dshExecutable:exists(c.dshExe),nodeExecutable:exists(c.nodePath),codexAppTools:!!server,codexSessions:exists(path.join(c.codexHome,'sessions')),dshProfile:exists(c.profile)},
  appToolsServer:server||null,appToolsError:error||null,enabled:config.read(path.join(c.stateRoot,'harness-dialogue/channel-policy.json'),{}).enabled===true};
}
function choices(args){
 const options={command:args.shift()||'plan'},keys={'--state-root':'stateRoot','--codex-home':'codexHome','--dsh-home':'dshHome','--dsh-exe':'dshExe','--node-path':'nodePath','--app-tools-server':'appToolsServer','--profile':'profile'};
 for(let i=0;i<args.length;i++){
  if(args[i]==='--authorize-dialogue'){options.authorize=true;continue;}
  if(args[i]==='--allow-create'){options.allowCreate=true;continue;}
  const key=keys[args[i]];if(!key||!args[i+1])throw Error('Unknown or missing option: '+args[i]);
  const value=args[++i];if(!path.isAbsolute(value))throw Error('Configuration paths must be absolute');options[key]=path.resolve(value);
 }
 return options;
}
function proposed(options){
 const old=config.settings();const c={version:1};
 for(const key of ['stateRoot','codexHome','dshHome','dshExe','nodePath','appToolsServer','profile'])c[key]=options[key]||old[key]||null;
 if(options.dshHome&&!options.profile)c.profile=path.join(c.dshHome,'profiles/desktop/cordis.patch.yml');
 return c;
}
function backup(c,file){
 const folder=path.join(c.stateRoot,'installation-backups');fs.mkdirSync(folder,{recursive:true});
 const dest=path.join(folder,hash(path.resolve(file))+'.txt');
 if(fs.existsSync(file)&&!fs.existsSync(dest))fs.copyFileSync(file,dest);
}
function writeText(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,value,'utf8');require('./runtime/atomic-json.cjs').replace(tmp,file);}
function profileBody(c){
 const q=x=>JSON.stringify(x),root=config.packageRoot;
 return ['- insert:','    - id: mcp-gpt-dialogue','      disabled: false','      name: '+q(path.join(root,'dsh/gpt-dialogue-client-0.1.0.mjs')),'      config:','        serverName: gpt_dialogue','        transport: stdio','        command: '+q(c.nodePath),'        args: [ '+q(path.join(root,'dsh/gpt-dialogue-mcp.cjs'))+' ]','        cwd: '+q(root),'        env:','          CODEX_DSH_BRIDGE_CONFIG: '+q(config.configFile()),'        toolCallTimeoutMs: 90000','        failOnStartupError: true'].join('\n');
}
function codexGuidance(){return '当用户明确要求联系 DeepSeek／DSH／GPT、绑定、恢复、暂停互聊，或收到实际 DSH 协作消息时，读取 deepseek-harness-bridge 技能。\n回复保持真实父消息并回实际来源窗口；当前窗口暂停只影响选中配对，监听保留。只在用户授权范围内通讯，新窗口创建取决于安装授权。普通聊天不全量同步。';}
function dshGuidance(){return '双向聊天使用原生 send_to_gpt、bind_dialogue、resume_dialogue、stop_dialogue、ensure_listener、dialogue_status。\n首次联络先显示完整正文，再发送一次；已配对窗口的正常最终回复自动转发。回复实际 GPT 消息保持后台 reply_to。可见内容只写正文。暂停与恢复遵循当前窗口的人类意图，引用或问题不作为控制命令。';}
async function verifyNative(threadId){
 const {connectAuthorizedApp}=require('./runtime/channel-service.cjs');
 const connected=await connectAuthorizedApp({controlThreadId:threadId});connected.client.close();
}
async function install(options,dependencies={}){
 if(options.authorize!==true)throw Error('Installation requires explicit --authorize-dialogue consent in the actual Codex chat');
 const threadId=process.env.CODEX_THREAD_ID;if(!validThread(threadId))throw Error('Install from a real Codex Desktop chat; never set or copy CODEX_THREAD_ID');
 const c=proposed(options);const original=config.read(config.configFile(),null);
 if(original&&JSON.stringify(original)!==JSON.stringify(c))throw Error('An installation config already exists; preserve it and review changes before reinstalling');
 const existing=config.read(path.join(c.stateRoot,'harness-dialogue/channel-policy.json'),null);
 if(existing?.enabled){
  if(existing.controlThreadId!==threadId)throw Error('This installation is already controlled by another actual chat');
  return {installed:true,reused:true,enabled:true,automaticCreation:existing.createUnboundTargets};
 }
 const skill=path.join(c.codexHome,'skills/deepseek-harness-bridge');
 if(fs.existsSync(skill))throw Error('A skill with the same name already exists; preserve that installation instead of overwriting it');
 const registry=config.read(path.join(c.stateRoot,'harness-dialogue/registry.json'),{});
 if(Object.keys(registry.conversations||{}).length)throw Error('This state directory contains prior bindings; choose a new state root rather than overwriting history');
 if(process.platform!=='win32')throw Error('This release supports Windows only');
 if(Number(process.versions.node.split('.')[0])<22)throw Error('Run setup with Node.js 22 or newer');
 if(!fs.existsSync(c.dshExe)||!fs.existsSync(c.nodePath))throw Error('DSH Desktop and Node.js must be installed first');
 // Config writes contain paths only. Activation follows native identity proof.
 atomic(config.configFile(),c);
 try{
  const check=dependencies.profileCall||profileCall;
  const probe=check(c,{command:'probe'});if(!probe.compatible)throw Error('Only DSH 0.2.0-rc.2 has been validated; detected '+probe.version);
  const profileText=text(c.profile),cleanProfile=removeBlock(profileText);
  if(check(c,{command:'validate-text',file:c.profile,text:cleanProfile}).existingDialogue)throw Error('Another GPT dialogue adapter already exists');
  // Native YAML inventory must also catch unmanaged GPT entries.
  const inventory=check(c,{command:'validate',file:c.profile});
  if(inventory.existingDialogue&&!profileText.includes(START))throw Error('An unmanaged GPT dialogue adapter exists; preserve it');
  const nextProfile=putBlock(profileText,profileBody(c));check(c,{command:'validate-text',file:c.profile,text:nextProfile});
  await (dependencies.verifyNative||verifyNative)(threadId);
  const time=new Date().toISOString(),spool=path.join(c.stateRoot,'spool');
  for(const sub of ['harness-dialogue','harness-event-relay','harness-mailbox','harness-routing','harness-bridge-state','spool/contexts','spool/receipts','spool/controls','spool/dsh-to-gpt'])fs.mkdirSync(path.join(c.stateRoot,sub),{recursive:true});
  atomic(path.join(c.stateRoot,'harness-dialogue/registry.json'),{version:1,conversations:{}});
  atomic(path.join(c.stateRoot,'harness-routing/state.json'),{version:1,mode:'latest',sequence:0,current:{threadId:null,sequence:0},groups:{},tasks:{}});
  atomic(path.join(c.stateRoot,'harness-mailbox/config.json'),{version:1,commandScope:'all-sessions',globalEnabledAt:time,enabledByThreadId:threadId,sessions:{}});
  const profileFile=c.profile,codexAgents=path.join(c.codexHome,'AGENTS.md'),dshAgents=path.join(c.dshHome,'AGENTS.md');
  const changes=[[profileFile,nextProfile],[codexAgents,putBlock(text(codexAgents),codexGuidance())],[dshAgents,putBlock(text(dshAgents),dshGuidance())]];
  for(const [file]of changes)backup(c,file);
  fs.mkdirSync(path.dirname(skill),{recursive:true});fs.cpSync(path.join(config.packageRoot,'skills/deepseek-harness-bridge'),skill,{recursive:true,errorOnExist:true,force:false});
  atomic(path.join(skill,'bridge-link.json'),{packageRoot:config.packageRoot,configFile:config.configFile()});
  try{for(const [file,value]of changes)writeText(file,value);}catch(e){for(const [file]of changes)writeText(file,removeBlock(text(file)));fs.rmSync(skill,{recursive:true,force:true});throw e;}
  atomic(path.join(c.stateRoot,'installation.json'),{version:1,packageVersion:'0.1.0',packageRoot:config.packageRoot,installedAt:time,skill,managedFiles:changes.map(x=>x[0])});
  atomic(path.join(c.stateRoot,'harness-dialogue/channel-policy.json'),{version:2,enabled:true,authorizedAt:time,authorizedByThreadId:threadId,controlThreadId:threadId,spoolRoot:spool,createUnboundTargets:options.allowCreate===true,routeRepliesToSource:true,perWindowAutomaticDialogue:true,stopPolicy:'human-only',naturalFinish:{version:1,enabled:true,enabledAt:time,authorizedByThreadId:threadId}});
  return {installed:true,enabled:true,automaticCreation:options.allowCreate===true,listenerStarted:false,nextStep:'Restart DSH Desktop and open a new Codex chat; use channel ensure for listener validation'};
 }catch(e){if(!original){fs.unlinkSync(config.configFile());}throw e;}
}
async function shutdown(c){
 const ipc=require('./runtime/channel-ipc.cjs'),relay=path.join(c.stateRoot,'harness-event-relay');
 const status=config.read(path.join(relay,'status.json'),{});
 if(status.pid&&ipc.alive(status.pid)&&status.state!=='stopped'){
  atomic(path.join(relay,'stop.request'),{reason:'user-requested-uninstall',time:new Date().toISOString()});
  const until=Date.now()+12000;while(Date.now()<until&&ipc.alive(status.pid)){await new Promise(r=>setTimeout(r,150));if(config.read(path.join(relay,'status.json'),{}).state==='stopped')break;}
  if(config.read(path.join(relay,'status.json'),{}).state!=='stopped'&&ipc.alive(status.pid))throw Error('Listener did not stop; installation is preserved');
 }
 const lock=config.read(path.join(c.stateRoot,'harness-dialogue/channel-service.lock'),{});
 if(lock.pid&&ipc.alive(lock.pid)){
  if(!Number.isSafeInteger(lock.pid)||lock.pid<=0)throw Error('Invalid service PID');
  const command=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"(Get-CimInstance Win32_Process -Filter 'ProcessId = "+lock.pid+"').CommandLine"],{encoding:'utf8',windowsHide:true}).trim();
  if(!command.toLowerCase().includes(path.join(config.packageRoot,'runtime/channel-service.cjs').toLowerCase()))throw Error('Service identity is not confirmed; do not stop another process');
  process.kill(lock.pid);
 }
}
async function uninstall(){
 const c=config.settings(),record=config.read(path.join(c.stateRoot,'installation.json'),null);
 if(!record||record.packageRoot!==config.packageRoot)throw Error('This directory does not own the recorded installation');
 await shutdown(c);
 const policyFile=path.join(c.stateRoot,'harness-dialogue/channel-policy.json'),policy=config.read(policyFile,{});atomic(policyFile,{...policy,enabled:false,disabledAt:new Date().toISOString()});
 for(const file of record.managedFiles){backup(c,file);writeText(file,removeBlock(text(file)));}
 const expected=path.join(c.codexHome,'skills/deepseek-harness-bridge'),link=config.read(path.join(expected,'bridge-link.json'),{});
 if(path.resolve(record.skill)!==path.resolve(expected)||link.packageRoot!==config.packageRoot)throw Error('Skill ownership has changed; preserve that directory');
 fs.rmSync(expected,{recursive:true,force:true});
 atomic(path.join(c.stateRoot,'installation.json'),{...record,uninstalledAt:new Date().toISOString()});
 return {uninstalled:true,statePreserved:true,backupsPreserved:true,nextStep:'Restart both desktops; existing conversations are retained'};
}
async function doctor(){
 const c=config.settings(),result=plan(c);
 if(result.checks.dshExecutable){try{result.dsh=profileCall(c,{command:'probe'});}catch(e){result.dsh={compatible:false,error:e.message};}}
 const skill=path.join(c.codexHome,'skills/deepseek-harness-bridge'),link=config.read(path.join(skill,'bridge-link.json'),{});
 result.conflicts={sameNameSkill:fs.existsSync(skill)&&link.packageRoot!==config.packageRoot,unmanagedDialogueAdapter:false};
 if(result.checks.dshProfile&&result.dsh?.compatible){try{const inventory=profileCall(c,{command:'validate',file:c.profile});result.conflicts.unmanagedDialogueAdapter=inventory.existingDialogue&&!text(c.profile).includes(START);}catch(e){result.profileError=e.message;}}
 const status=config.read(path.join(c.stateRoot,'harness-event-relay/status.json'),{state:'not-started'}),alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
 result.listener={state:status.state,processExists:!!status.pid&&alive(status.pid),lastError:status.lastPeerError||status.lastAutoError||null};
 result.dependenciesReady=Object.values(result.checks).every(Boolean)&&result.dsh?.compatible===true;
 result.ready=result.dependenciesReady&&!Object.values(result.conflicts).some(Boolean)&&!result.profileError;
 return result;
}
async function main(args){const options=choices(args);
 if(options.command==='plan')return plan({...config.settings(),...proposed(options)});
 if(options.command==='doctor')return doctor();
 if(options.command==='install')return install(options);
 if(options.command==='uninstall')return uninstall();
 throw Error('Commands: plan, doctor, install --authorize-dialogue [--allow-create], uninstall');
}
module.exports={removeBlock,putBlock,choices,proposed,profileBody,plan,install,doctor,main,START,END};
if(require.main===module)main(process.argv.slice(2)).then(result=>console.log(JSON.stringify({ok:true,result},null,2)),error=>{console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;});
