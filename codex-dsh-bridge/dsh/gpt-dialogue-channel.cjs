'use strict';
const shared=require('node:path').join(__dirname,'../runtime');
const {request,home}=require(shared+'/channel-ipc.cjs');
const fs=require('node:fs'),path=require('node:path');
function enabled(){try{return JSON.parse(fs.readFileSync(path.join(home,'channel-policy.json'),'utf8')).enabled===true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function invoke(name,args,source){
 const commands={send_to_gpt:'send',dialogue_status:'status',stop_dialogue:'stop',bind_dialogue:'bind',resume_dialogue:'resume',ensure_listener:'ensure'};
 if(!source)throw Error('The native DSH execution context is required');
 return request({command:commands[name],text:args.text,replyTo:args.reply_to,messageId:args.message_id,targetThreadId:args.target_thread_id,conversationId:args.conversation_id,title:args.title,finish:args.finish_action,source:{...source,kind:'dsh'}});
}
module.exports={enabled,invoke};
