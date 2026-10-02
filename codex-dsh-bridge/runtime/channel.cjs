'use strict';
require('./config.cjs').applyEnvironment();
const fs=require('node:fs');
const {request}=require('./channel-ipc.cjs');
function parseArgs(args){const req={command:args.shift()},keys={'--text':'text','--reply-to':'replyTo','--conversation':'conversationId','--dsh-session':'targetSessionId','--codex-thread':'targetThreadId','--message-id':'messageId','--title':'title','--finish':'finish'};for(let n=0;n<args.length;n++){if(args[n]==='--body-file'){if(req.text!==undefined||!args[n+1])throw Error('Choose one body input');req.text=fs.readFileSync(args[++n],'utf8');continue;}if(args[n]==='--stdin'){req.text=fs.readFileSync(0,'utf8');continue;}if(!keys[args[n]]||args[n+1]===undefined)throw Error('Use open/send/prepare-reply/bind/resume/stop/status/ensure/inbox/ack and the named target or actual reply ID');req[keys[args[n]]]=args[++n];}return req;}
async function execute(req){const threadId=process.env.CODEX_THREAD_ID;if(!require('./routing.cjs').validThread(threadId))throw Error('Invoke the Codex entry from the actual Codex window; do not copy a different window identity');return request({...req,source:{kind:'codex',threadId}});}
module.exports={execute,parseArgs};
if(require.main===module)execute(parseArgs(process.argv.slice(2))).then(result=>console.log(JSON.stringify({ok:true,result},null,2)),e=>{console.log(JSON.stringify({ok:false,error:e.message}));process.exitCode=1;});
