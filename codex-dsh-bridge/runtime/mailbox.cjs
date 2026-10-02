'use strict';
require('./config.cjs').applyEnvironment();
// Durable inbox over selected Harness chats. Transports text; never executes it.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {parseUserCommand}=require('./command-prefix.cjs');
const policy=require('./global-inbox-policy.cjs');
const home=process.env.HARNESS_MAILBOX_STATE||require('./config.cjs').statePath('harness-mailbox');
function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const t=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(t,JSON.stringify(value,null,2)+'\n');fs.renameSync(t,file);}
function read(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT'&&fallback!==undefined)return fallback;throw e;}}
function itemPath(id){if(!/^[a-f0-9]{24}$/.test(id))throw Error('Invalid inbox id');return path.join(home,'inbox',id+'.json');}
function parseMessages(text){
 const result=[];
 for(const match of text.matchAll(/(?:^|\n)```codex-inbox\s*\n([\s\S]*?)\n```/g)){
  if(Buffer.byteLength(match[1])>16384)throw Error('Inbox message exceeds 16 KiB');
  const v=JSON.parse(match[1]);
  if(!v||!['chat','task'].includes(v.kind)||typeof v.text!=='string'||!v.text.trim()||v.text.length>12000)throw Error('Invalid inbox message: expected kind chat/task and nonempty text');
  if(v.authorizationRef!==undefined&&typeof v.authorizationRef!=='string')throw Error('authorizationRef must be text');
  result.push({kind:v.kind,text:v.text,...v.authorizationRef?{authorizationRef:v.authorizationRef}:{}});
 }
 return result;
}
async function locked(fn){
 fs.mkdirSync(home,{recursive:true});const lock=path.join(home,'mailbox.lock');let fd;
 for(let n=0;;n++){try{fd=fs.openSync(lock,'wx');break;}catch(e){if(e.code!=='EEXIST')throw e;if(n>=400)throw Error('Mailbox is busy. If a previous process crashed, inspect mailbox.lock before manually removing it.');await new Promise(r=>setTimeout(r,50));}}
 fs.writeFileSync(fd,JSON.stringify({pid:process.pid,time:new Date().toISOString()}));
 try{return await fn();}finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
async function execute(req,dependencies={}){
 return locked(async()=>{
  const {Harness,execute:bridge,messages}=dependencies.bridge||require('./bridge.cjs');
  const configFile=path.join(home,'config.json');const config=read(configFile,{version:1,sessions:{}});
  if(req.command==='enable-global-commands'){
   const result=policy.enable(config,process.env.CODEX_THREAD_ID);atomic(configFile,config);
   return {...result,commandScope:config.commandScope,enabledByThreadId:config.enabledByThreadId,globalEnabledAt:config.globalEnabledAt};
  }
  if(req.command==='disable-global-commands'){
   config.commandScope='bound-sessions';atomic(configFile,config);return {commandScope:config.commandScope};
  }
  if(req.command==='discover'){
   const result=policy.register(config,await new Harness().list());atomic(configFile,config);return result;
  }
  if(req.command==='bind'){
   if(!policy.validSession(req.sessionId))throw Error('Valid sessionId required');
   if(config.sessions[req.sessionId]&&!config.sessions[req.sessionId].discoveryScope)return {bound:true,reused:true,sessionId:req.sessionId};
   const h=new Harness(),s=await h.history(req.sessionId,{maxPages:1});
   config.sessions[req.sessionId]={cursor:s.cursor,title:s.projections.title,boundAt:new Date().toISOString(),...(policy.isGlobal(config)?{notBefore:config.globalEnabledAt}:{})};atomic(configFile,config);
   return {bound:true,sessionId:req.sessionId,cursor:s.cursor};
  }
  if(req.command==='poll'){
   const errors=[];let imported=0;const global=policy.isGlobal(config);
   const ids=req.sessionIds===undefined?Object.keys(config.sessions).filter(id=>global||!config.sessions[id].discoveryScope):req.sessionIds;
   if(!Array.isArray(ids)||ids.some(id=>!config.sessions[id]||(!global&&config.sessions[id].discoveryScope)))throw Error('poll sessionIds must be bound or globally discovered chats');
   if(ids.length){
    const h=new Harness();
    for(const sessionId of ids){const setting=config.sessions[sessionId];try{
     const history=await h.history(sessionId,{maxPages:100});
     if(policy.hasGap(history,setting,global))throw Error('History gap: inbox cursor is older than authorized fetched pages');
     for(const message of messages(history.records).filter(m=>policy.admissible(m,setting,global))){
      let parsed;try{parsed=message.role==='user'?parseUserCommand(message.text):parseMessages(message.text);}catch(e){const errorId=crypto.createHash('sha256').update(sessionId+':'+message.seq).digest('hex').slice(0,24);const ef=path.join(home,'rejected',errorId+'.json');if(!fs.existsSync(ef)){atomic(ef,{sessionId,seq:message.seq,error:e.message});errors.push({sessionId,seq:message.seq,error:e.message});}continue;}
      for(let n=0;n<parsed.length;n++){
       const id=crypto.createHash('sha256').update(sessionId+':'+message.seq+':'+n).digest('hex').slice(0,24),file=itemPath(id);
       if(!fs.existsSync(file)){
        const metadata=global?{authorizationScope:policy.SCOPE,sourceTitle:setting.title,sourceWorkingDirectory:setting.workingDirectory}:{};
        const parsedMessage=global?{...parsed[n],authorizationRef:'User explicitly enabled commands from all DSH chats; user-role message after enable time'}:parsed[n];
        atomic(file,{id,sessionId,sourceSeq:message.seq,receivedAt:new Date().toISOString(),status:'pending',...metadata,message:parsedMessage});imported++;
       }
      }
     }
     setting.cursor=history.cursor;
    }catch(e){errors.push({sessionId,error:e.message});}}
    atomic(configFile,config);
   }
   const dir=path.join(home,'inbox');const items=fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>f.endsWith('.json')).map(f=>read(path.join(dir,f))):[];
   const pending=items.filter(x=>x.status==='pending'||x.status==='reply-pending').sort((a,b)=>a.receivedAt.localeCompare(b.receivedAt));
   return {imported,pending:pending.slice(0,5),remaining:Math.max(0,pending.length-5),errors};
  }
  if(req.command==='reply'){
   const file=itemPath(req.id),item=read(file);
   if(!config.sessions[item.sessionId])throw Error('Reply session is not bound');
   if(typeof req.text!=='string'||!req.text.trim()||req.text.length>12000)throw Error('Reply text required, maximum 12000 characters');
   const disposition=req.disposition||'done';if(!['done','needs-user'].includes(disposition))throw Error('disposition must be done or needs-user');
   if(item.reply&&(item.reply.text!==req.text||item.reply.disposition!==disposition))throw Error('A different reply already exists for this message');
   if(item.status==='done'||item.status==='needs-user')return {id:item.id,status:item.status,delivery:item.delivery,reused:true};
   item.reply={text:req.text,disposition};item.status='reply-pending';atomic(file,item);
   const text='【Codex 回执｜'+item.id+'】\n'+req.text+'\n\n这是回执，不是新任务。无需调用工具，也不要再次输出 codex-inbox 消息，除非用户提出新的转交请求。';
   const delivery=await bridge({command:'send',sessionId:item.sessionId,taskId:'mailbox-reply-'+item.id,mode:'queue',text,returnToCodex:false});
   item.delivery=delivery;item.status=disposition;item.repliedAt=new Date().toISOString();atomic(file,item);
   return {id:item.id,status:item.status,delivery};
  }
  if(req.command==='get')return read(itemPath(req.id));
  if(req.command==='config')return config;
  throw Error('Commands: bind, enable-global-commands, disable-global-commands, discover, poll, reply, get, config');
 });
}
module.exports={parseMessages,parseUserCommand,execute};
if(require.main===module)(async()=>{const i=process.argv.indexOf('--request');const raw=fs.readFileSync(i>=0?process.argv[i+1]:0,'utf8').replace(/^\uFEFF/,'');console.log(JSON.stringify({ok:true,...await execute(JSON.parse(raw))},null,2));})().catch(e=>{console.log(JSON.stringify({ok:false,error:e.message}));process.exitCode=1;});
