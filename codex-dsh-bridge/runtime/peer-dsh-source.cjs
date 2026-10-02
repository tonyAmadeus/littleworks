'use strict';
require('./config.cjs').applyEnvironment();
const crypto=require('node:crypto');
const textOf=parts=>(parts||[]).filter(p=>p.type==='text').map(p=>p.text||'').join('');
// Every cross-window send proves the actual tool call and the assistant body
// in that same turn. A claimed session ID or an outbox file alone is insufficient.
async function verifyDSHSource(m,c,{readHistory,readSummary}){
 const sessionId=m.sourceSessionId||c.sessionId;
 if(typeof sessionId!=='string'||!/^[-a-zA-Z0-9_]{1,160}$/.test(sessionId))return {verified:false};
 const foreign=sessionId!==c.sessionId,boundary=foreign?c.sourceSessions?.[sessionId]:null;
 if(foreign&&(c.sourceScope!=='all-sessions'||!Number.isFinite(Date.parse(c.sourceScopeEnabledAt))))return {verified:false,reason:'New DSH windows have not been authorized for this dialogue'};
 const history=await readHistory(sessionId),events=history.records.map(r=>r.event).filter(Boolean);
 const rows=events.filter(e=>e.type==='assistant/message').map(e=>({event:e,text:textOf(e.data.message?.content||e.data.content)}));
 let call,source;
 if(m.origin){
  if(m.origin.version!==1||m.origin.sessionId!==sessionId||typeof m.origin.callId!=='string')return {verified:false};
  call=events.find(e=>e.type==='tool/call'&&e.data.callId===m.origin.callId&&e.data.name==='mcp__gpt_dialogue__send_to_gpt');
  if(!call||call.time<Date.parse(foreign?c.sourceScopeEnabledAt:c.createdAt))return {verified:false};
  let args;try{args=JSON.parse(call.data.arguments);}catch{return {verified:false};}
  const expectedId=args.message_id||(c.routingPolicy==='source'?'dsh-v2-':'dsh-call-')+crypto.createHash('sha256').update(JSON.stringify(c.routingPolicy==='source'?[sessionId,call.data.callId]:[c.conversationId,sessionId,call.data.callId])).digest('hex').slice(0,32);
  if(args.text!==m.body||(args.reply_to||null)!==m.replyTo||expectedId!==m.messageId||(args.finish_action||undefined)!==m.completion?.action)return {verified:false};
  source=rows.filter(r=>r.event.data.turn===call.data.turn&&r.event.seq<call.seq&&r.text.includes(m.body)).at(-1);
 }else{
  if(foreign&&(!boundary||m.automatic!==true))return {verified:false,reason:'A new DSH window needs its real MCP tool execution identity'};
  const cursor=foreign?boundary.initialCursor:c.initialCursor;
  source=rows.filter(r=>r.event.seq>cursor&&r.text.includes(m.body)&&
    (m.sourceSeq===undefined||r.event.seq===m.sourceSeq)).at(-1);
 }
 if(!source)return {verified:false};
 const proof={verified:true,sourceSessionId:sessionId,sourceSeq:source.event.seq,sourceTurn:source.event.data.turn,
   ...call?{sourceCallId:call.data.callId,sourceCallSeq:call.seq}: {}};
 if(foreign&&!boundary){const summary=await readSummary(sessionId);if(!summary)return {verified:false};
  proof.registerSource={sessionId,title:history.projections?.title||sessionId,cwd:summary.cwd,
    initialCursor:history.cursor,enabledAt:new Date().toISOString(),verifiedCallId:call.data.callId};
 }
 return proof;
}
module.exports={verifyDSHSource};
