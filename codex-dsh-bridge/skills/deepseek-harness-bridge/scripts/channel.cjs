'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
try{
 const link=JSON.parse(fs.readFileSync(path.join(__dirname,'../bridge-link.json'),'utf8'));
 const r=spawnSync(process.execPath,[path.join(link.packageRoot,'run-channel.cjs'),...process.argv.slice(2)],{env:{...process.env,CODEX_DSH_BRIDGE_CONFIG:link.configFile},stdio:'inherit',windowsHide:true});
 if(r.error)throw r.error;process.exitCode=r.status??1;
}catch(e){console.error('Bridge installation link is unavailable: '+e.message);process.exitCode=1;}
