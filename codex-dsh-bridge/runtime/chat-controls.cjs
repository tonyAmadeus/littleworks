'use strict';
require('./config.cjs').applyEnvironment();
const path=require('node:path');
// Only direct, short human imperatives are handled without model interpretation.
function intent(text){
 if(typeof text!=='string'||text.length>240||/[?？"“”‘’`]|如何|怎么|是不是|是否|例如|比如|可以说|之类|不要暂停|别停止|不要停止|不用停止/.test(text))return null;
 const s=text.replace(/[\s，,。！!、：:；;]/g,'');
 if(/^(?:请|麻烦)?(?:先|现在)?(?:停止|暂停|打断)(?:一下|一会儿)?(?:你们的|你们|双方的|双方|当前窗口的|本窗口的)?(?:互聊|聊天|对话)(?:吧|了)?(?:(?:保留|保持|不要关闭|别关)(?:监听|窗口绑定|监听和窗口绑定|监听及绑定|连接|链接)(?:开启|运行)?)?$/.test(s)||/^(?:请)?(?:先)?(?:停一停|停一下|暂停一下|别聊了|不要聊了|不要继续聊了|你们先别聊了|你们不要聊了)(?:你们)?(?:先)?(?:不要聊了|别聊了)?$/.test(s))return 'stop';
 if(/^(?:请|麻烦)?(?:恢复|继续|接着|重新开始|开始)(?:一下)?(?:你们的|你们|双方的|双方|当前窗口的|本窗口的)?(?:互聊|聊天|对话|聊)(?:吧|了)?(?:接着刚才的话题聊)?$/.test(s))return 'resume';
 return null;
}
function currentScope(state,c){
 if(c.routingPolicy!=='source')return true;
 const rows=Object.values(state.list()).filter(x=>x.routingPolicy==='source'&&x.status!=='migrated'&&x.createdByThreadId===c.createdByThreadId);
 const selected=state.read(path.join(state.home,'window-defaults.json'),{})['codex:'+c.createdByThreadId];
 return selected?selected===c.conversationId:rows.length===1;
}
function humanCodexText(text){return typeof text==='string'&&!text.includes('<codex_delegation>')&&!text.startsWith('<external_codex_apps_')&&!text.includes('<environment_context>')&&!text.includes('# AGENTS.md instructions');}
function contact(text){return intent(text)==='resume'||typeof text==='string'&&/(?:告诉|问问|转交|发给|联系|跟|和)\s*(?:DeepSeek|DSH|GPT|大肥鱼|鲸鱼娘)|(?:你们|双方).*(?:继续|接着|聊|新话题)|恢复对话|开始新话题/i.test(text);}
module.exports={intent,currentScope,humanCodexText,contact};
