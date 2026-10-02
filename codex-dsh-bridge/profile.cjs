'use strict';
// Runs only inside the installed DSH Electron runtime for its YAML parser.
const fs=require('node:fs'),path=require('node:path');
const YAML=require(path.join(path.dirname(process.execPath),'resources/app.asar/dsh/node_modules/yaml'));
function check(file,text){const rows=YAML.parse(text);if(rows!==null&&!Array.isArray(rows))throw Error('DSH profile must be a YAML patch array');return rows||[];}
function hasDialogue(rows){const inspect=r=>r?.id==='mcp-gpt-dialogue'||r?.config?.serverName==='gpt_dialogue'||Array.isArray(r?.insert)&&r.insert.some(inspect);return rows.some(inspect);}
function probe(){
 const version=require(path.join(path.dirname(process.execPath),'resources/app.asar/dsh/package.json')).version;
 const deps=['@deepseek-ai/dsh-mcp-client','@modelcontextprotocol/client','@deepseek-ai/dsh-subprocess','ws','yaml'];
 const {createRequire}=require('node:module'),req=createRequire(path.join(path.dirname(process.execPath),'resources/app.asar/dsh/package.json'));
 for(const name of deps)req.resolve(name);
 return {version,compatible:version==='0.2.0-rc.2',requiredModules:deps.length};
}
function main(){
 const data=JSON.parse(fs.readFileSync(0,'utf8'));
 if(data.command==='probe')return probe();
 const text=fs.existsSync(data.file)?fs.readFileSync(data.file,'utf8').replace(/^\uFEFF/,''):'',rows=check(data.file,text);
 if(data.command==='validate')return {valid:true,existingDialogue:hasDialogue(rows)};
 if(data.command==='validate-text'){const parsed=check(data.file,data.text);return {valid:true,existingDialogue:hasDialogue(parsed)};}
 throw Error('Unknown profile operation');
}
if(require.main===module){try{console.log(JSON.stringify({ok:true,result:main()}));}catch(e){console.log(JSON.stringify({ok:false,error:e.message}));process.exitCode=1;}}
module.exports={check,hasDialogue};
