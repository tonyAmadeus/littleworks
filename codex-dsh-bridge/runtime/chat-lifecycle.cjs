'use strict';
require('./config.cjs').applyEnvironment();
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const now=()=>new Date().toISOString();
function enabled(c){return c.routingPolicy==='source'&&c.naturalFinish?.enabled===true;}
function topic(time=now(),humanAt=null){return {version:1,id:'topic-'+crypto.randomUUID(),phase:'talking',startedAt:time,humanAt};}
function stamp(c,action){
 if(!enabled(c)){if(action)throw Error('Natural finish is not enabled in this pair');return {};}
 if(c.topic?.phase==='idle')throw Error('Topic is waiting for a new explicit human contact');
 if(action&&!['propose','accept','reject'].includes(action))throw Error('finish must be propose, accept or reject');
 return {topicId:c.topic.id,...action?{completion:{action,goalResolved:action!=='reject',deliveriesComplete:action!=='reject'}}:{}};
}
function outstanding(state,c,candidate,rows=state.ledgers(c)){
 const live=rows.filter(m=>!['blocked','rejected'].includes(m.status));
 if(live.some(m=>['reserved','sending','uncertain'].includes(m.status)&&m.messageId!==candidate.messageId))throw Error('Unconfirmed delivery prevents natural finish');
 const episode=live.filter(m=>m.topicId===c.topic.id);
 const leaves=episode.filter(m=>m.expectsReply&&['accepted','observed'].includes(m.status)&&m.messageId!==candidate.replyTo&&!episode.some(child=>child.replyTo===m.messageId));
 if(leaves.length)throw Error('Unanswered messages prevent natural finish');
 for(const sub of ['dsh-to-gpt','gpt-to-dsh']){
  const dir=path.join(c.spoolRoot,sub);
  for(const n of fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>n.endsWith('.json')):[]){const m=state.read(path.join(dir,n));const receipt=state.read(path.join(c.spoolRoot,'receipts',m.messageId+'.json'),null);if(m.conversationId===c.conversationId&&m.topicId===c.topic.id&&m.messageId!==candidate.messageId&&!state.ledger(m.messageId)&&!['blocked','rejected'].includes(receipt?.status))throw Error('Queued messages prevent natural finish');}
 }
 const jobs=process.env.HARNESS_BRIDGE_STATE||require('./config.cjs').statePath('harness-bridge-state');
 for(const n of fs.existsSync(jobs)?fs.readdirSync(jobs).filter(n=>n.endsWith('.json')):[]){const j=state.read(path.join(jobs,n));if(j.sessionId===c.sessionId&&j.replyChannel!=='peer'&&Date.parse(j.createdAt)>=Date.parse(c.topic.startedAt)&&['queued','submitted','running','accepted','streaming'].includes(j.status))throw Error('A running task prevents natural finish');}
}
function validate(state,c,m,rows){
 if(!enabled(c)){if(m.completion||m.topicId)throw Error('Natural finish is not enabled');return;}
 if(m.topicId!==c.topic.id)throw Error('Stale topic message; do not replay it');
 if(c.topic.phase==='idle')throw Error('Topic is idle; AI output cannot reopen it');
 const a=m.completion?.action;
 if(!a){if(m.expectsReply===false)throw Error('Only a verified final confirmation may suppress replies');return;}
 if(!['propose','accept','reject'].includes(a))throw Error('Invalid natural finish action');
 if(a!=='reject'&&(m.completion.goalResolved!==true||m.completion.deliveriesComplete!==true))throw Error('Completion requires resolved goals and delivered results');
 if(a==='propose'){
  if(c.topic.phase!=='talking'||!m.expectsReply)throw Error('A finish proposal is already pending; respond to it');
  outstanding(state,c,m,rows);
 }else{
  const p=state.ledger(m.replyTo);
  if(c.topic.phase!=='closing'||p?.messageId!==c.topic.proposalId||p.completion?.action!=='propose'||p.topicId!==c.topic.id||p.from===m.from)throw Error('Finish response must select the actual current proposal');
  if(a==='accept'){if(m.expectsReply!==false)throw Error('A final confirmation must not request another reply');outstanding(state,c,m,rows);}
  else if(!m.expectsReply)throw Error('An objection must allow a substantive reply');
 }
}
function reserved(c,m){
 if(!enabled(c))return c;
 if(!m.completion){if(c.topic.phase==='closing'&&m.replyTo===c.topic.proposalId){c.topic={...c.topic,phase:'talking',lastObjectionId:m.messageId};delete c.topic.proposalId;delete c.topic.confirmationId;}return c;}
 if(m.completion.action==='propose')c.topic={...c.topic,phase:'closing',proposalId:m.messageId,proposedAt:now()};
 if(m.completion.action==='accept')c.topic={...c.topic,confirmationId:m.messageId,confirmedAt:now()};
 if(m.completion.action==='reject'){c.topic={...c.topic,phase:'talking',lastObjectionId:m.messageId};delete c.topic.proposalId;delete c.topic.confirmationId;}
 return c;
}
function observed(c,m){
 if(enabled(c)&&c.status==='active'&&c.topic.phase==='closing'&&c.topic.id===m.topicId&&c.topic.confirmationId===m.messageId&&m.completion?.action==='accept'&&m.status==='observed')c.topic={...c.topic,phase:'idle',finishedAt:now()};
 return c;
}
async function humanContact(state,c,humanAt){
 if(!enabled(c)||c.status!=='active'||!Number.isFinite(Date.parse(humanAt))||Date.parse(humanAt)<=Math.max(Date.parse(c.topic?.humanAt||c.naturalFinish.enabledAt),Date.parse(c.topic?.finishedAt||c.naturalFinish.enabledAt)))return c;
 await require('./peer-clean-dialogue.cjs').cancel(state,c,'new-human-topic',undefined,humanAt);
 return state.changeConversation(c.conversationId,value=>{
  if(value.status!=='active')return value;
  if(value.topic.phase==='idle'||value.topic.phase==='closing')value.topicHistory=[...(value.topicHistory||[]),value.topic];
  if(value.topic.phase==='idle'||value.topic.phase==='closing')value.topic=topic(now(),humanAt);
  else {value.topic={...value.topic,phase:'talking',humanAt};delete value.topic.proposalId;delete value.topic.confirmationId;}
  return value;
 });
}
module.exports={enabled,topic,stamp,outstanding,validate,reserved,observed,humanContact};
