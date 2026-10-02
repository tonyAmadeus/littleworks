'use strict';
require('./config.cjs').applyEnvironment();
// Routing is kept in a one-shot sidecar, never in the visible conversation body.
const crypto=require('node:crypto'),path=require('node:path');
function file(state,c){return path.join(state.home,'auto','prepared',c.conversationId+'.json');}
function read(state,c){return state.read(file(state,c),null);}
function sameVisibleBody(expected,actual){return actual===expected||actual===expected+'\n';}
function cleanBody(text){if(typeof text!=='string'||!text.trim()||text.length>12000)throw Error('Message requires 1..12000 characters');if(/^\s*【(?:GPT|DeepSeek)\s*→/.test(text)||/(?:^|\n)\s*协作通道[:：]\s*\{/.test(text))throw Error('Clean dialogue must contain only the visible answer body');return text;}
async function prepare(state,c,{threadId,text,replyTo,afterOffset,finish}){return state.locked(()=>{
 c=state.get(c.conversationId);
 if(c.status!=='active'||state.stopRequested(c)||c.presentation?.mode!=='body-only'||!c.auto?.enabled)throw Error('An active clean automatic dialogue is required');
 if(c.createdByThreadId!==threadId)throw Error('Only the actual owning chat may prepare an automatic reply');
 cleanBody(text);if(!Number.isSafeInteger(afterOffset)||afterOffset<c.auto.gptOffset)throw Error('Invalid real chat boundary');
 if(replyTo){const parent=state.ledger(replyTo);if(!parent||parent.conversationId!==c.conversationId||parent.from!=='dsh'||parent.targetThreadId!==threadId||!['accepted','observed'].includes(parent.status)||!parent.expectsReply)throw Error('Reply must select an actual delivered incoming message');if(state.ledgers(c).some(m=>m.replyTo===replyTo&&!['blocked','rejected'].includes(m.status)))throw Error('A reply has already been submitted for this message');}
 const episode=require('./chat-lifecycle.cjs').stamp(c,finish);const candidate={messageId:'preparing',from:'gpt',replyTo:replyTo||null,expectsReply:finish!=='accept',...episode};require('./chat-lifecycle.cjs').validate(state,c,candidate,state.ledgers(c));
 const previous=read(state,c);
 if(previous&&['prepared','sending'].includes(previous.status)){if(previous.text===text&&previous.replyTo===(replyTo||null)&&previous.threadId===threadId&&previous.completion?.action===finish&&previous.topicId===episode.topicId)return {...previous,reused:true};throw Error('A prepared reply is still pending; do not replace or guess its target');}
 const draft={version:1,conversationId:c.conversationId,messageId:'gpt-plain-'+crypto.randomUUID(),threadId,text,replyTo:replyTo||null,afterOffset,preparedAt:new Date().toISOString(),status:'prepared',...episode};
 state.atomic(file(state,c),draft);return draft;
});}
async function cancel(state,c,reason,offset,timestamp){return state.locked(()=>{const draft=read(state,c);if(draft?.status==='prepared'&&(offset===undefined||offset>=draft.afterOffset)&&(timestamp===undefined||Date.parse(timestamp)>=Date.parse(draft.preparedAt))){state.atomic(file(state,c),{...draft,status:'cancelled',cancelledAt:new Date().toISOString(),reason});return true;}return false;});}
async function claim(state,c,text,offset,timestamp){return state.locked(()=>{
 const latest=state.get(c.conversationId),draft=read(state,c);
 if(latest.status!=='active'||state.stopRequested(latest)||draft?.status!=='prepared'||!sameVisibleBody(draft.text,text)||offset<draft.afterOffset||!Number.isFinite(Date.parse(timestamp))||Date.parse(timestamp)<Date.parse(draft.preparedAt))return null;
 if(draft.topicId&&draft.topicId!==latest.topic?.id)return null;
 if(draft.threadId!==latest.createdByThreadId)throw Error('Prepared reply owner changed');
 const claimed={...draft,status:'sending',visibleText:text,sourceByteOffset:offset,sourceTimestamp:timestamp};state.atomic(file(state,c),claimed);return claimed;
});}
async function finish(state,c,messageId,status,error){return state.locked(()=>{const draft=read(state,c);if(draft?.messageId===messageId&&draft.status==='sending')state.atomic(file(state,c),{...draft,status,finishedAt:new Date().toISOString(),...(error?{error}: {})});});}
module.exports={file,read,sameVisibleBody,cleanBody,prepare,cancel,claim,finish};
