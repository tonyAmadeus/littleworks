'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const packageRoot=path.resolve(__dirname,'..');
function read(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
function configFile(){return process.env.CODEX_DSH_BRIDGE_CONFIG||path.join(packageRoot,'bridge.config.json');}
function settings(){
 const c=read(configFile(),{}),user=process.env.USERPROFILE||os.homedir(),local=process.env.LOCALAPPDATA||path.join(user,'AppData/Local');
 const stateRoot=c.stateRoot||path.join(local,'CodexDshBridge/state');
 return {...c,packageRoot,stateRoot,spoolRoot:path.join(stateRoot,'spool'),
  codexHome:c.codexHome||process.env.CODEX_HOME||path.join(user,'.codex'),
  dshHome:c.dshHome||process.env.DSH_HOME||path.join(user,'.dsh'),
  dshExe:c.dshExe||path.join(local,'Programs/DeepSeek Harness/DeepSeek Harness.exe'),
  nodePath:c.nodePath||process.env.CODEX_MCP_NODE_PATH||process.execPath,
  profile:c.profile||path.join(c.dshHome||process.env.DSH_HOME||path.join(user,'.dsh'),'profiles/desktop/cordis.patch.yml')};
}
function statePath(...parts){return path.join(settings().stateRoot,...parts);}
function applyEnvironment(){
 const c=settings();
 const names={HARNESS_DIALOGUE_STATE:'harness-dialogue',HARNESS_BRIDGE_STATE:'harness-bridge-state',HARNESS_ROUTING_STATE:'harness-routing',HARNESS_MAILBOX_STATE:'harness-mailbox'};
 for(const [name,sub]of Object.entries(names))process.env[name]||=path.join(c.stateRoot,sub);
 process.env.DSH_HOME||=c.dshHome;
}
function discoverAppTools(c=settings()){
 if(c.appToolsServer){if(!fs.existsSync(c.appToolsServer))throw Error('Configured Codex app-tools server is missing');return c.appToolsServer;}
 const cache=path.join(c.codexHome,'plugins/cache'),found=[];
 for(const owner of fs.existsSync(cache)?fs.readdirSync(cache,{withFileTypes:true}):[]){if(!owner.isDirectory()||owner.isSymbolicLink())continue;
  const folder=path.join(cache,owner.name,'codex-app-tools');
  for(const version of fs.existsSync(folder)?fs.readdirSync(folder,{withFileTypes:true}):[]){if(!version.isDirectory()||version.isSymbolicLink())continue;const server=path.join(folder,version.name,'server.mjs');if(fs.existsSync(server))found.push({version:version.name,server});}
 }
 found.sort((a,b)=>b.version.localeCompare(a.version,'en',{numeric:true}));
 const chosen=found.find(x=>x.version==='0.1.5')||found[0];
 if(!chosen)throw Error('Codex app-tools plugin was not found; install it through Codex before enabling the bridge');
 return chosen.server;
}
module.exports={settings,statePath,applyEnvironment,discoverAppTools,configFile,packageRoot,read};
