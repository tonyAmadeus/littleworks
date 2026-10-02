'use strict';
require('./config.cjs').applyEnvironment();
const SCOPE='all-sessions';
const validSession=id=>typeof id==='string'&&/^[-a-zA-Z0-9_]{1,160}$/.test(id);
const validThread=id=>typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const epoch=value=>typeof value==='number'?value:Date.parse(value);
function isGlobal(config){
 if(config.commandScope!==SCOPE)return false;
 if(!Number.isFinite(Date.parse(config.globalEnabledAt)))throw Error('Invalid global command enable time');
 return true;
}
function enable(config,threadId,now=new Date().toISOString()){
 if(!validThread(threadId))throw Error('Invoke from a genuine Codex chat to enable global commands');
 if(isGlobal(config)){
  config.enabledByThreadId??=config.commandThreadId??threadId;
  delete config.commandThreadId;
  return {reused:true};
 }
 config.commandScope=SCOPE;config.enabledByThreadId=threadId;config.globalEnabledAt=now;delete config.commandThreadId;
 for(const setting of Object.values(config.sessions))setting.notBefore=now;
 return {reused:false};
}
function register(config,sessions,now=new Date().toISOString()){
 if(!isGlobal(config))throw Error('Global command scope is not enabled');
 const sessionIds=[],registered=[];
 for(const s of sessions){
  const id=s.sessionId;if(!validSession(id))continue;
  sessionIds.push(id);
  if(!config.sessions[id]){
   config.sessions[id]={cursor:0,boundAt:now,discoveryScope:SCOPE,notBefore:config.globalEnabledAt};registered.push(id);
  }
  const setting=config.sessions[id];
  setting.title=s.projections?.values?.title??s.title??setting.title??id;
  setting.workingDirectory=s.cwd??setting.workingDirectory;
  setting.notBefore??=config.globalEnabledAt;
 }
 return {commandScope:SCOPE,sessionIds:[...new Set(sessionIds)],registered,enabledByThreadId:config.enabledByThreadId,globalEnabledAt:config.globalEnabledAt};
}
function admissible(message,setting,global){
 if(message.seq<=setting.cursor)return false;
 if(!global)return true;
 const time=epoch(message.time),threshold=epoch(setting.notBefore);
 return message.role==='user'&&Number.isFinite(time)&&time>=threshold;
}
function hasGap(history,setting,global){
 if(!history.hasMore)return false;
 const first=history.records[0]?.event;
 if((first?.seq??Infinity)<=setting.cursor+1)return false;
 // Earlier pages wholly before enable time are outside the authorized inbox.
 if(global&&Number.isFinite(epoch(first?.time))&&epoch(first.time)<=epoch(setting.notBefore))return false;
 return true;
}
module.exports={SCOPE,validSession,validThread,isGlobal,enable,register,admissible,hasGap};
