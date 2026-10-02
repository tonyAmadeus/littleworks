// Context adapter for the existing GPT MCP connection. No DSH installation changes.
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import sourceContext from './gpt-dialogue-context.cjs';
import displayContext from './gpt-dialogue-display.cjs';
const requireDSH=createRequire(path.join(path.dirname(process.execPath),'resources/app.asar/dsh/package.json'));
const load=name=>import(pathToFileURL(requireDSH.resolve(name)).href);
const upstream=await load('@deepseek-ai/dsh-mcp-client');
const {Client}=await load('@modelcontextprotocol/client');
const {StdioClientTransport}=await load('@modelcontextprotocol/client/stdio');
const {scrubbedParentEnv}=await load('@deepseek-ai/dsh-subprocess');
export const name='gpt-dialogue-context-client';
export const inject=upstream.inject;
export const Config=upstream.Config;
export async function apply(ctx,config){
 if(config.serverName!=='gpt_dialogue'||config.transport!=='stdio')throw Error('This adapter only serves the existing GPT dialogue stdio connection');
 const client=new Client({name:'dsh-gpt-dialogue-context',version:'0.3.0'},
   {capabilities:{},versionNegotiation:{mode:'auto'}});
 const transport=new StdioClientTransport({command:config.command,args:config.args,
   env:{...scrubbedParentEnv(),...config.env},cwd:config.cwd});
 const disposers=[];let closed=false;
 const close=async()=>{if(closed)return;closed=true;for(const dispose of disposers)dispose();await client.close();};
 ctx.effect(()=>close,'gpt-dialogue.context-connection');
 try{
  await client.connect(transport);
  const advertised=await client.listTools();
  for(const tool of advertised.tools){
   if(!['send_to_gpt','dialogue_status','stop_dialogue','bind_dialogue','resume_dialogue','ensure_listener'].includes(tool.name))throw Error('Unexpected GPT dialogue tool');
   const definition=upstream.createMcpToolDefinition(ctx,{name:'mcp__gpt_dialogue__'+tool.name,
     rawName:tool.name,description:tool.description??'',inputSchema:tool.inputSchema,
     outputSchema:tool.outputSchema,
     call:(args,execution)=>client.callTool({name:tool.name,arguments:args,
       _meta:{[sourceContext.META_KEY]:sourceContext.sourceFromExecution(execution)}},
       {signal:execution.signal,timeout:config.toolCallTimeoutMs,toolDefinition:tool})});
   disposers.push(ctx.tools.register(definition));
  }
  const instructions=client.getInstructions()?.trimEnd()??'';
  ctx.inject(['systemPrompt'],inner=>inner.systemPrompt.section({name:'mcp:gpt_dialogue',
    order:inner.systemPrompt.getSectionOrder('MCP_SERVERS'),interpolate:false,
    text:context=>[instructions,displayContext.runtimeContext(context?.agent)].filter(Boolean).join('\n\n')}));
 }catch(error){await close();throw error;}
}
