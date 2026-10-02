'use strict';
const {spawnSync}=require('node:child_process'),path=require('node:path');
const config=require('./runtime/config.cjs');
const r=spawnSync(config.settings().dshExe,['--expose-internals',path.join(__dirname,'runtime/channel.cjs'),...process.argv.slice(2)],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',CODEX_DSH_BRIDGE_CONFIG:config.configFile()},stdio:'inherit',windowsHide:true});
if(r.error){console.error(r.error.message);process.exitCode=1;}else process.exitCode=r.status??1;
