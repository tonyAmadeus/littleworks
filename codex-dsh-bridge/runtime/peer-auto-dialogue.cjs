'use strict';
require('./config.cjs').applyEnvironment();
// Observe complete, real chat records. Never consume reasoning or tool outputs.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const defaultState=require('./peer-dialogue-state.cjs');
const clean=require('./peer-clean-dialogue.cjs');
const lifecycle=require('./chat-lifecycle.cjs'),controls=require('./chat-controls.cjs');
function textOf(content){return (content||[]).filter(x=>['text','input_text','output_text'].includes(x.type)).map(x=>x.text||'').join('');}
function addressedGPT(text){return typeof text==='string'&&/^\s*【GPT\s*→\s*(?:DeepSeek|DSH)(?:\s*[｜|][^】]*)?】\s*\S/.test(text);}
function wantsReply(text,c){return c?.stopPolicy==='human-only'||!/\n\s*【本轮结束】\s*$/.test(text);}
function sourceId(c,kind,key){return kind+'-auto-'+crypto.createHash('sha256').update(c.conversationId+':'+key).digest('hex').slice(0,32);}
function metadata(log){const fd=fs.openSync(log,'r');try{const b=Buffer.alloc(65536),n=fs.readSync(fd,b,0,b.length,0);const line=b.subarray(0,n).toString('utf8').split('\n')[0];const value=JSON.parse(line);if(value.type!=='session_meta')throw Error('Missing real Codex chat metadata');return value.payload;}finally{fs.closeSync(fd);}}
function verifyLog(log,threadId,workspace){const resolved=fs.realpathSync(log),meta=metadata(resolved);if(meta.id!==threadId||fs.realpathSync(meta.cwd).toLowerCase()!==fs.realpathSync(workspace).toLowerCase())throw Error('Codex message source must be the actual authorized chat and workspace');return resolved;}
function findLog(threadId,workspace){const root=path.join(require('./config.cjs').settings().codexHome,'sessions');const matches=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.isSymbolicLink())continue;const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(e.name.endsWith(threadId+'.jsonl'))matches.push(p);}}walk(root);if(matches.length!==1)throw Error('Expected exactly one local log for the actual Codex chat');return verifyLog(matches[0],threadId,workspace);}
function chooseReply(state,c,from){const rows=state.ledgers(c);const pending=rows.filter(m=>m.from!==from&&m.expectsReply&&['accepted','observed'].includes(m.status)&&!rows.some(child=>child.replyTo===m.messageId&&!['blocked','rejected'].includes(child.status)));if(pending.length>1)throw Error('Multiple pending messages: use the explicit message tool with reply_to');return pending[0]?.messageId||null;}
function addressedReply(text,state,c){const hint=text.match(/^\s*【GPT\s*→\s*(?:DeepSeek|DSH)\s*[｜|]\s*([-a-zA-Z0-9_]{1,160})\s*】/)?.[1];if(!hint)return chooseReply(state,c,'gpt');const parent=state.ledger(hint);if(!parent||parent.conversationId!==c.conversationId||parent.from!=='dsh')throw Error('Addressed reply must name the actual incoming DeepSeek message');return hint;}
class PeerAutoDialogue {
 constructor({state=defaultState,peer,sendGPT,readDSH,onStatus=()=>{},onError=()=>{}}){Object.assign(this,{state,peer,sendGPT,readDSH,onStatus,onError});this.logs=new Map();this.pending=new Set();this.closed=false;this.dshBusy=false;this.reported=new Set();}
 checkpoint(c){return path.join(this.state.home,'auto',c.conversationId+'.json');}
 position(c){return this.state.read(this.checkpoint(c),{enabledAt:c.auto.enabledAt,gptOffset:c.auto.gptOffset,dshCursor:c.auto.dshCursor});}
 savePosition(c,p){this.state.atomic(this.checkpoint(c),p);}
 active(c){const latest=this.state.get(c.conversationId);return !this.closed&&latest.status==='active'&&latest.auto?.enabled===true&&!this.state.stopRequested(latest);}
 sessionIds(){return [...new Set(Object.values(this.state.list()).filter(c=>c.status==='active'&&c.auto?.enabled).flatMap(c=>[c.sessionId,...Object.keys(c.sourceSessions||{})]))];}
 start(){this.started=true;fs.mkdirSync(this.state.home,{recursive:true});this.registryWatcher=fs.watch(this.state.home,(_,name)=>{if(name==='registry.json')this.refresh();});this.refresh();}
 refresh(){if(this.closed||!this.started)return;try{const active=Object.values(this.state.list()).filter(c=>c.status==='active'&&c.auto?.enabled);const wanted=new Set(active.map(c=>c.conversationId));for(const [id,entry]of this.logs)if(!wanted.has(id)){entry.watcher.close();clearTimeout(entry.timer);this.logs.delete(id);}for(const c of active)if(!this.logs.has(c.conversationId)){verifyLog(c.auto.codexLogPath,c.createdByThreadId,c.codexWorkspace||c.workspace);const entry={c,busy:false,dirty:false};entry.watcher=fs.watch(path.dirname(c.auto.codexLogPath),(_,name)=>{if(!name||name===path.basename(c.auto.codexLogPath)){clearTimeout(entry.timer);entry.timer=setTimeout(()=>void this.scanGPT(entry),30);}});this.logs.set(c.conversationId,entry);void this.scanGPT(entry);this.pending.add(c.sessionId);}this.onStatus({autoDialogues:active.map(c=>({conversationId:c.conversationId,sessionId:c.sessionId,codexThreadId:c.createdByThreadId,enabledAt:c.auto.enabledAt,gptTrigger:c.presentation?.mode==='body-only'?'prepared-complete-message':'addressed-complete-message',dshTrigger:'completed-turn'}))});void this.drainDSH();}catch(e){this.onError(e);}}
 async scanGPT(entry){entry.dirty=true;if(entry.busy||this.closed)return;entry.busy=true;try{while(entry.dirty&&!this.closed){entry.dirty=false;const c=this.state.get(entry.c.conversationId);if(!this.active(c))break;verifyLog(c.auto.codexLogPath,c.createdByThreadId,c.codexWorkspace||c.workspace);const p=this.position(c),stat=fs.statSync(c.auto.codexLogPath);if(stat.size<p.gptOffset)throw Error('Codex chat log was truncated; automatic source requires review');if(stat.size===p.gptOffset)continue;const fd=fs.openSync(c.auto.codexLogPath,'r');let b;try{b=Buffer.alloc(stat.size-p.gptOffset);fs.readSync(fd,b,0,b.length,p.gptOffset);}finally{fs.closeSync(fd);}let start=0;for(let n=0;n<b.length;n++)if(b[n]===10){const offset=p.gptOffset+start;const line=b.subarray(start,n).toString('utf8');start=n+1;if(!line.trim())continue;const record=JSON.parse(line);await this.onGPTRecord(c,record,offset);if(!this.active(c))break;}const latest=this.position(c);this.savePosition(c,{...latest,gptOffset:p.gptOffset+start});}}catch(e){this.report('gpt:'+entry.c.conversationId,e);}finally{entry.busy=false;}}
 async onGPTRecord(c,record,offset){
  if(!this.active(c)||Date.parse(record.timestamp)<Date.parse(c.auto.enabledAt))return;
  const m=record.payload;
  if(record.type==='event_msg'&&m?.type==='user_message'&&controls.humanCodexText(m.message)){await clean.cancel(this.state,c,'new-human-input',offset,record.timestamp);if(controls.currentScope(this.state,c)&&(this.state.get(c.conversationId).topic?.phase!=='idle'||controls.contact(m.message)))await lifecycle.humanContact(this.state,c,record.timestamp);}
  if(record.type==='event_msg'&&controls.currentScope(this.state,c)&&((m?.type==='user_message'&&controls.humanCodexText(m.message)&&this.state.isStopText(m.message))||(m?.type==='task_aborted'&&m.reason==='interrupted'))){await clean.cancel(this.state,c,'human-stop');await this.state.stop(c.conversationId,m.type==='task_aborted'?'gpt-user-interrupt':'gpt-user-stop');this.refresh();return;}
  if(record.type!=='response_item'||m?.type!=='message')return;
  const text=textOf(m.content);
  if(m.role==='user'){if(!controls.humanCodexText(text))return;await clean.cancel(this.state,c,'new-human-input',offset,record.timestamp);if(controls.currentScope(this.state,c)&&(this.state.get(c.conversationId).topic?.phase!=='idle'||controls.contact(m.message||text)))await lifecycle.humanContact(this.state,c,record.timestamp);if(controls.currentScope(this.state,c)&&this.state.isStopText(text)){await this.state.stop(c.conversationId,'gpt-user-stop');this.refresh();}return;}
  if(m.role!=='assistant')return;
  if(c.presentation?.mode==='body-only'){
   const draft=await clean.claim(this.state,c,text,offset,record.timestamp);if(!draft)return;
   try{
    const result=await this.sendGPT({command:'send',conversationId:c.conversationId,messageId:draft.messageId,text,replyTo:draft.replyTo,expectsReply:draft.completion?.action!=='accept',topicId:draft.topicId,completion:draft.completion,updateRouting:false,capturedSource:{threadId:c.createdByThreadId,logPath:c.auto.codexLogPath,offset,timestamp:record.timestamp}});
    await this.state.update(draft.messageId,{sourceKind:'codex-chat-record',sourceLogPath:c.auto.codexLogPath,sourceByteOffset:offset,sourceTimestamp:record.timestamp});
    await clean.finish(this.state,c,draft.messageId,'sent');this.onStatus({lastAutoGPTMessageId:draft.messageId,lastAutoGPTAt:new Date().toISOString()});return result;
   }catch(e){await clean.finish(this.state,c,draft.messageId,'failed',e.message);this.report(draft.messageId,e);return;}
  }
  if(!addressedGPT(text))return;
  const id=sourceId(c,'gpt',offset);if(this.state.ledger(id))return;
  const matching=this.state.ledgers(c).find(row=>row.from==='gpt'&&row.body===text&&!['blocked','rejected'].includes(row.status));if(matching)return;
  try{const replyTo=addressedReply(text,this.state,c);const result=await this.sendGPT({command:'send',conversationId:c.conversationId,messageId:id,text,replyTo,expectsReply:wantsReply(text,c),updateRouting:false});await this.state.update(id,{sourceKind:'codex-chat-record',sourceLogPath:c.auto.codexLogPath,sourceByteOffset:offset,sourceTimestamp:record.timestamp});this.onStatus({lastAutoGPTMessageId:id,lastAutoGPTAt:new Date().toISOString()});return result;}catch(e){this.report(id,e);}
 }
 onDSHFrame(sessionId,frame){const e=frame.event||frame.record?.event;if(frame.type==='snapshot'||e?.type==='turn/end'){this.pending.add(sessionId);void this.drainDSH();}}
 async drainDSH(){if(this.dshBusy||this.closed)return;this.dshBusy=true;try{while(this.pending.size&&!this.closed){const sessionId=this.pending.values().next().value;this.pending.delete(sessionId);for(const c of Object.values(this.state.list()).filter(x=>x.status==='active'&&x.auto?.enabled&&(x.sessionId===sessionId||x.sourceSessions?.[sessionId]))){if(!this.active(c))continue;try{const history=await this.readDSH(sessionId);await this.onDSHHistory(c,history,sessionId);}catch(e){this.report('dsh:'+c.conversationId+':'+sessionId,e);}}}}finally{this.dshBusy=false;}}
 async onDSHHistory(c,history,sessionId=c.sessionId){
  const foreign=sessionId!==c.sessionId,boundary=foreign?c.sourceSessions?.[sessionId]:{initialCursor:c.auto.dshCursor,enabledAt:c.auto.enabledAt};
  if(!boundary)return;
  const es=history.records.map(r=>r.event).filter(Boolean).sort((a,b)=>a.seq-b.seq),position=this.position(c);
  const cursor=foreign?(position.dshSessions?.[sessionId]??boundary.initialCursor):position.dshCursor;
  for(const end of es.filter(e=>e.type==='turn/end'&&e.seq>cursor)){
   if(!this.active(c))break;
   try{
    if(end.time<Date.parse(boundary.enabledAt))continue;
    const turn=end.data.turn,start=es.filter(e=>e.type==='turn/start'&&e.data.turn===turn&&e.seq<end.seq).at(-1);
    if(!start)throw Error('Incomplete DSH turn history; cannot prove reply association');
    if(start.seq<=boundary.initialCursor||start.time<Date.parse(boundary.enabledAt))continue;
    if(require('./peer-human-input.cjs').humanInterruption(end.data.reason)){await this.state.stop(c.conversationId,'dsh-user-interrupt');this.refresh();break;}
    if(end.data.reason?.kind!=='completed')continue;
    const rows=es.filter(e=>e.type==='assistant/message'&&e.data.turn===turn&&e.seq>start.seq&&e.seq<end.seq);
    const final=rows.filter(e=>textOf(e.data.message?.content||e.data.content).trim()).at(-1);if(!final)continue;
    const body=textOf(final.data.message?.content||final.data.content);
    // Real user inputs have no data.turn. Exclude instructions/tool contexts that also use user/message.
    const users=es.filter(e=>e.type==='user/message'&&e.seq>start.seq&&e.seq<end.seq&&e.data.source?.kind==='user');
    if(users.some(e=>require('./peer-human-input.cjs').humanInput(this.state,c,sessionId,e)&&this.state.isStopText(textOf(e.data.message?.content||e.data.content)))){await this.state.stop(c.conversationId,'dsh-user-stop');this.refresh();break;}
    const delivered=this.state.ledgers(c),parents=delivered.filter(m=>m.from==='gpt'&&(m.targetSessionId||c.sessionId)===sessionId&&users.some(u=>u.data.source?.rpcId===m.requestId));
    if(parents.length>1)throw Error('Multiple GPT inputs in one DSH turn; explicit reply_to is required');
    const parent=parents[0];
    if(parent&&lifecycle.enabled(c)&&users.some(u=>u.data.source?.rpcId===parent.requestId&&textOf(u.data.message?.content||u.data.content)===parent.body)){await this.state.update(parent.messageId,{status:'observed',observedAt:new Date(end.time).toISOString(),observedBySessionId:sessionId});}
    const humans=users.filter(e=>require('./peer-human-input.cjs').humanInput(this.state,c,sessionId,e));
    if(humans.length&&(this.state.get(c.conversationId).topic?.phase!=='idle'||controls.contact(textOf(humans.at(-1).data.message?.content||humans.at(-1).data.content))))await lifecycle.humanContact(this.state,c,new Date(humans.at(-1).time).toISOString());
    const latestScope=this.state.get(c.conversationId);if(lifecycle.enabled(latestScope)&&latestScope.topic.phase==='idle')continue;
    if(parent&&!parent.expectsReply&&!humans.length)continue;
    const replyParent=parent&&!parent.expectsReply&&humans.length?null:parent;
    if(replyParent&&delivered.some(m=>m.replyTo===replyParent.messageId&&!['blocked','rejected'].includes(m.status)))continue;
    if(delivered.some(m=>m.from==='dsh'&&(m.sourceSessionId||c.sessionId)===sessionId&&m.sourceTurn===turn&&!['blocked','rejected'].includes(m.status)))continue;
    const outbox=path.join(c.spoolRoot,'dsh-to-gpt');
    const explicit=fs.readdirSync(outbox).filter(n=>n.endsWith('.json')).map(n=>this.state.read(path.join(outbox,n))).some(m=>m.conversationId===c.conversationId&&(m.sourceSessionId||c.sessionId)===sessionId&&!m.automatic&&m.from==='dsh'&&rows.some(e=>textOf(e.data.message?.content||e.data.content).includes(m.body)));
    if(explicit)continue;
    const episode=lifecycle.stamp(this.state.get(c.conversationId));
    const message={...episode,version:1,messageId:sourceId(c,'dsh',foreign?sessionId+':'+end.seq:end.seq),conversationId:c.conversationId,from:'dsh',to:'gpt',createdAt:new Date().toISOString(),body,replyTo:replyParent?.messageId||null,expectsReply:wantsReply(body,c),automatic:true,...foreign?{sourceSessionId:sessionId,sourceSeq:final.seq,sourceWindow:true}: {}};
    this.state.atomic(path.join(outbox,message.messageId+'.json'),message);await this.peer.deliver(message);
    this.onStatus({lastAutoDSHMessageId:message.messageId,lastAutoDSHAt:new Date().toISOString()});
   }catch(e){this.report('dsh-end:'+end.seq,e);}
   finally{const latest=this.position(c);this.savePosition(c,foreign?{...latest,dshSessions:{...latest.dshSessions,[sessionId]:Math.max(latest.dshSessions?.[sessionId]??boundary.initialCursor,end.seq)}}:{...latest,dshCursor:Math.max(latest.dshCursor,end.seq)});}
  }
 }
 report(key,error){if(!this.reported.has(key)){this.reported.add(key);this.onError(error);}}
 close(){this.closed=true;this.registryWatcher?.close();for(const entry of this.logs.values()){entry.watcher.close();clearTimeout(entry.timer);}this.logs.clear();}
}
module.exports={PeerAutoDialogue,textOf,addressedGPT,wantsReply,sourceId,verifyLog,findLog,metadata,chooseReply};
