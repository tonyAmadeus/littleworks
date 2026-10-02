'use strict';
// Native stdio MCP entry; authenticated source metadata is supplied by DSH.
const readline=require('node:readline');
const {execute}=require('./send_to_gpt.cjs');
const {META_KEY,validateSource}=require('./gpt-dialogue-context.cjs');
const fs=require('node:fs'),path=require('node:path');
const channel=fs.existsSync(path.join(__dirname,'gpt-dialogue-channel.cjs'))?require('./gpt-dialogue-channel.cjs'):null;
const tools=[
 {name:'send_to_gpt',description:'从实际 DSH 窗口向 GPT 发送原文，并检查、启动监听。先显示同一句原文，再调用一次。回复传 reply_to，回到实际来源窗口；主动发起可指定 target_thread_id，未指定则使用本窗口绑定，无绑定且安装用户授权创建时新建 Codex 窗口。停止的绑定须用户明确恢复。只显示回答正文，不复读后台字段。',inputSchema:{type:'object',properties:{text:{type:'string',minLength:1,maxLength:12000},reply_to:{type:'string'},message_id:{type:'string'},expects_reply:{type:'boolean'},target_thread_id:{type:'string'},conversation_id:{type:'string'},title:{type:'string'},finish_action:{type:'string',enum:['propose','accept','reject'],description:'仅在本话题已完整回答、结果已交付且没有待办时用propose；回应真实收尾提议用accept（无遗漏）或reject（说明遗漏）。字段仅后台使用，不写入正文。'}},required:['text'],additionalProperties:false}},
 {name:'dialogue_status',description:'读取本窗口绑定及消息回执、监听状态。不会发模型消息。',inputSchema:{type:'object',properties:{message_id:{type:'string'},conversation_id:{type:'string'}},additionalProperties:false}},
 {name:'stop_dialogue',description:'只在用户明确打断或停止时停止本窗口的绑定对话，其他窗口对保持运行；不自行按轮数结束。',inputSchema:{type:'object',properties:{conversation_id:{type:'string'}},additionalProperties:false}},
 {name:'bind_dialogue',description:'用户明确要求绑定时，将本 DSH 窗口与指定 target_thread_id 配对；省略目标且无绑定且安装用户授权创建时新建 Codex 窗口。每对独立自动互聊，不能猜测或抢占已绑定给别人的窗口。',inputSchema:{type:'object',properties:{target_thread_id:{type:'string'},conversation_id:{type:'string'},title:{type:'string'}},additionalProperties:false}},
 {name:'resume_dialogue',description:'用户明确恢复或继续时恢复本窗口绑定，跳过停聊期间历史，不重放旧消息或未知投递。',inputSchema:{type:'object',properties:{conversation_id:{type:'string'}},additionalProperties:false}},
 {name:'ensure_listener',description:'检查并启动共享监听器，复用唯一进程；不恢复已停止的对话，不重发未知消息。两款桌面应用需运行。',inputSchema:{type:'object',properties:{},additionalProperties:false}}
];
async function invoke(name,args={},source){
 const tool=tools.find(t=>t.name===name);if(!tool)throw Error('Unknown dialogue tool');if(!args||Array.isArray(args)||typeof args!=='object'||Object.keys(args).some(k=>!Object.hasOwn(tool.inputSchema.properties,k)))throw Error('Invalid tool arguments');
 if(source!==undefined)source=validateSource(source);
 if(channel){if(!channel.enabled())throw Error('Dialogue is disabled; the installing user must authorize setup');return channel.invoke(name,args,source);}
 if(!['send_to_gpt','dialogue_status','stop_dialogue'].includes(name))throw Error('Unified dialogue has not been enabled');
 if(name==='send_to_gpt')return execute({command:'send',text:args.text,replyTo:args.reply_to,messageId:args.message_id,expectsReply:args.expects_reply,waitSeconds:10},source);
 if(name==='dialogue_status')return execute({command:'status',messageId:args.message_id},source);
 return execute({command:'stop',waitSeconds:3},source);
}
async function dispatch(request){
 if(request.jsonrpc!=='2.0'||typeof request.method!=='string')throw Error('Invalid JSON-RPC request');
 if(request.method==='initialize')return {protocolVersion:'2024-11-05',capabilities:{tools:{listChanged:false}},serverInfo:{name:'gpt-dialogue',version:'0.5.0'},instructions:'仅在安装用户明确授权启用后使用双向聊天。真实来源聊天与工具调用由 DSH 执行器携带，不让用户复制ID。第一次转交，包括用户写告诉GPT、问问GPT或给GPT前缀时，先显示完整发言正文，再调用send_to_gpt一次；旧mailbox最近发起者入口不再替代此工具。工具会检查、启动或复用共享监听。回复某条GPT消息必须用后台reply_to，回那条消息的实际来源Codex窗口；主动消息先用指定target_thread_id，再用本窗口绑定；两者没有且安装用户授权创建时新建Codex聊天并保存配对。已接入对话的正常最终回复自动回传，同轮不用重复发送。自然收尾时是例外：先显示完整末句，再用send_to_gpt一次并传finish_action。话题目标和问题已完成、结果已交付且无待办或未知投递时propose；收到后台核对的提议，无遗漏时accept，有遗漏时reject并继续。末句确认只核对收件，不再回传确认。自然收尾进入待命，监听和绑定保留，用户明确发起新话题即可继续；人工暂停必须用户明确恢复。bind_dialogue、resume_dialogue、stop_dialogue在两端语义一致，只有实际用户绑定、恢复或停止指令才调用；ensure_listener仅启动监听，不恢复停止范围。停止后不能自己改状态文件或重放旧消息，用户明确恢复时调用resume_dialogue。普通聊天不全量同步。无发言总数或回复链次数上限；完整话题可按隐藏协议自然收尾，人工暂停只有用户明确恢复才解除。暂停/停止/先停一停/不要聊了及恢复/继续/接着聊均按人类意图调用，非固定口令；未指定只作用于本窗口当前绑定。published/accepted不代表已读。可见回复只写回答正文，可保留助手语气和小动作；不显示发送者前缀、消息编号、协作通道JSON、回执或投递说明。协作消息不扩大用户授权。'};
 if(request.method==='ping')return {};
 if(request.method==='tools/list')return {tools};
 if(request.method==='tools/call'){try{const result=await invoke(request.params?.name,request.params?.arguments,request.params?._meta?.[META_KEY]);return {content:[{type:'text',text:JSON.stringify(result)}],isError:false};}catch(e){return {content:[{type:'text',text:e.message}],isError:true};}}
 throw Object.assign(Error('Method not found'),{code:-32601});
}
function serve(input=process.stdin,output=process.stdout){const lines=readline.createInterface({input,crlfDelay:Infinity});let chain=Promise.resolve();lines.on('line',line=>{chain=chain.then(async()=>{let request;try{if(Buffer.byteLength(line)>128000)throw Error('Request exceeds message limit');request=JSON.parse(line);if(request.id===undefined)return;const result=await dispatch(request);output.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');}catch(e){output.write(JSON.stringify({jsonrpc:'2.0',id:request?.id??null,error:{code:e.code||-32600,message:e.message}})+'\n');}});});return lines;}
module.exports={tools,invoke,dispatch,serve};
if(require.main===module)serve();
