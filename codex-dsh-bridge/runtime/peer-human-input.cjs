'use strict';
require('./config.cjs').applyEnvironment();
const fs=require('node:fs'),path=require('node:path');
// Native GPT prompts appear as user/message in DSH; their RPCs are cooperation,
// never a new human stop instruction.
function humanInput(state,c,sessionId,event){
 if(event?.type!=='user/message'||event.data?.source?.kind!=='user')return false;
 const rpc=event.data.source.rpcId;if(!rpc)return true;
 if(state.ledgers(c).some(m=>m.from==='gpt'&&m.requestId===rpc))return false;
 const jobs=process.env.HARNESS_BRIDGE_STATE||require('./config.cjs').statePath('harness-bridge-state');
 for(const name of fs.existsSync(jobs)?fs.readdirSync(jobs).filter(n=>n.endsWith('.json')):[]){const j=state.read(path.join(jobs,name));if(j.sessionId===sessionId&&j.requestId===rpc)return false;}
 return true;
}
function humanInterruption(reason){return reason?.kind==='interrupted'||reason?.kind==='cancelled'||reason?.kind==='aborted'&&reason.reason?.kind==='user';}
module.exports={humanInput,humanInterruption};
