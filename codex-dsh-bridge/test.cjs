'use strict';
// Every test process uses isolated settings even when the package is installed.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-dsh-tests-')),file=path.join(temp,'config.json');
fs.writeFileSync(file,JSON.stringify({version:1,stateRoot:path.join(temp,'state'),codexHome:path.join(temp,'codex'),dshHome:path.join(temp,'dsh')}));
const env={...process.env,CODEX_DSH_BRIDGE_CONFIG:file};
for(const name of ['HARNESS_DIALOGUE_STATE','HARNESS_BRIDGE_STATE','HARNESS_ROUTING_STATE','HARNESS_MAILBOX_STATE','DSH_HOME'])delete env[name];
const tests=fs.readdirSync(path.join(__dirname,'runtime')).filter(n=>n.endsWith('.test.cjs')).map(n=>path.join(__dirname,'runtime',n));tests.push(path.join(__dirname,'distribution.test.cjs'));
try{const r=spawnSync(process.execPath,['--test',...tests],{env,stdio:'inherit',windowsHide:true});if(r.error)throw r.error;process.exitCode=r.status??1;}
finally{const absolute=fs.realpathSync(temp);if(path.dirname(absolute).toLowerCase()!==fs.realpathSync(os.tmpdir()).toLowerCase()||!path.basename(absolute).startsWith('codex-dsh-tests-'))throw Error('Test cleanup boundary changed');fs.rmSync(absolute,{recursive:true,force:true});}
