'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const setup=require('./setup.cjs'),config=require('./runtime/config.cjs');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'codex-dsh-distribution-'));
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);}
test('distribution contains no real user path, original chat identity or private runtime state',()=>{
 const forbidden=[/C:[\\/]Users[\\/]admin/i,/01a0[0-9a-f]{4}-[0-9a-f-]{27}/i,/session-(?:gpt-whale|dcdd3c0c|9516f3ed)/i];
 for(const file of walk(__dirname)){if(file.endsWith('distribution.test.cjs')||file.endsWith('MANIFEST.json'))continue;
  assert.ok(!/(?:^|[\\/])(?:\.credentials\.yaml|bridge\.config\.json|registry\.json|status\.json|installation\.json|bridge-link\.json)$/.test(file),file);
  const body=fs.readFileSync(file,'utf8');for(const pattern of forbidden)assert.equal(pattern.test(body),false,path.relative(__dirname,file));
 }
});
test('every static local source dependency is present in the package',()=>{
 for(const file of walk(__dirname).filter(n=>/\.(?:cjs|mjs)$/.test(n)&&!n.endsWith('.test.cjs'))){const body=fs.readFileSync(file,'utf8');
  const patterns=[/require\(['"](\.[^'"]+)['"]\)/g,/from\s+['"](\.[^'"]+)['"]/g];
  for(const re of patterns)for(const [,name]of body.matchAll(re))assert.ok(fs.existsSync(path.resolve(path.dirname(file),name)),path.relative(__dirname,file)+' -> '+name);
 }
});
test('managed edits preserve unrelated contents and reject malformed ownership markers',()=>{
 const original='# custom\n- id: model\n  config: {model: example}\n';
 const edited=setup.putBlock(original,'- insert: []');assert.equal(setup.removeBlock(edited).trimEnd(),original.trimEnd());
 assert.equal(setup.putBlock(edited,'- insert: []'),edited);
 assert.throws(()=>setup.removeBlock(setup.START+'\ntext'),/Invalid managed/);
});
test('config uses a caller-selected home and discovers the installed plugin rather than a fixed user directory',()=>{
 const c={codexHome:path.join(temp,'自定义用户'),appToolsServer:null};const server=path.join(c.codexHome,'plugins/cache/official/codex-app-tools/0.1.5/server.mjs');fs.mkdirSync(path.dirname(server),{recursive:true});fs.writeFileSync(server,'// fixture');assert.equal(config.discoverAppTools(c),server);
 assert.throws(()=>config.discoverAppTools({codexHome:path.join(temp,'none')}),/not found/);
});
test('installation refuses absent human consent and copied or missing actual window identity',async()=>{
 await assert.rejects(setup.install({}),/explicit/);
 const prior=process.env.CODEX_THREAD_ID;delete process.env.CODEX_THREAD_ID;
 try{await assert.rejects(setup.install({authorize:true}),/real Codex/);}finally{if(prior)process.env.CODEX_THREAD_ID=prior;}
});
test('source-preserving pairs require separate consent before creating new chats',async()=>{
 const {ChannelManager}=require('./runtime/channel-manager.cjs');let created=0;
 const manager=new ChannelManager({state:{home:temp,read:()=>({}),list:()=>({})},spoolRoot:temp,policy:{createUnboundTargets:false},harness:{call:()=>{created++;}},client:{tool:()=>{created++;}}});
 await assert.rejects(manager.targetPair({kind:'codex',threadId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},{}),/not authorized/);
 await assert.rejects(manager.targetPair({kind:'dsh',sessionId:'session-test'},{}),/not authorized/);assert.equal(created,0);
});
test('UTF-8 text body input keeps newlines, quotations and interpolation characters intact',()=>{
 const file=path.join(temp,'发言 正文.txt'),body='第一行 🐋\n"引号" `反引号` $() ${example}\n第二行';fs.writeFileSync(file,body);
 const {parseArgs}=require('./runtime/channel.cjs');assert.equal(parseArgs(['prepare-reply','--body-file',file]).text,body);
});
test('a copied package installs and uninstalls in directories with Chinese and spaces while preserving unrelated settings',()=>{
 const root=path.join(temp,'独立安装 含空格'),cfg=path.join(root,'bridge.config.json'),homes=path.join(temp,'独立 用户');fs.cpSync(__dirname,root,{recursive:true});
 const script=path.join(temp,'exercise.cjs');
 fs.writeFileSync(script,`const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
 const root=process.argv[2],home=process.argv[3],config=require(path.join(root,'runtime/config.cjs')),setup=require(path.join(root,'setup.cjs'));
 const c={stateRoot:path.join(home,'状态'),codexHome:path.join(home,'codex'),dshHome:path.join(home,'dsh'),dshExe:process.execPath,nodePath:process.execPath};c.profile=path.join(c.dshHome,'profiles/desktop/cordis.patch.yml');
 for(const [file,body]of [[c.profile,'- id: original\\n  config: {model: original}\\n'],[path.join(c.codexHome,'AGENTS.md'),'# Existing GPT rules\\n'],[path.join(c.dshHome,'AGENTS.md'),'# Existing DSH persona\\n']]){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);}
 const mock={profileCall:(c,r)=>r.command==='probe'?{compatible:true,version:'fixture'}:{valid:true,existingDialogue:false},verifyNative:async actual=>assert.equal(actual,process.env.CODEX_THREAD_ID)};
 (async()=>{const result=await setup.install({...c,authorize:true,allowCreate:false},mock);assert.equal(result.automaticCreation,false);
 const policy=JSON.parse(fs.readFileSync(path.join(c.stateRoot,'harness-dialogue/channel-policy.json')));assert.equal(policy.controlThreadId,process.env.CODEX_THREAD_ID);assert.equal(policy.createUnboundTargets,false);assert.ok(policy.naturalFinish.enabled);
 const profile=fs.readFileSync(c.profile,'utf8');assert.ok(profile.includes('model: original'));assert.ok(profile.includes('mcp-gpt-dialogue'));assert.ok(profile.includes('CODEX_DSH_BRIDGE_CONFIG'));
 const record=JSON.parse(fs.readFileSync(path.join(c.stateRoot,'installation.json')));assert.ok(fs.existsSync(path.join(record.skill,'bridge-link.json')));
 const deleted=await setup.main(['uninstall']);assert.ok(deleted.statePreserved);assert.equal(fs.readFileSync(c.profile,'utf8').trim(),'- id: original\\n  config: {model: original}');assert.equal(fs.readFileSync(path.join(c.dshHome,'AGENTS.md'),'utf8').trim(),'# Existing DSH persona');assert.ok(!fs.existsSync(record.skill));
 console.log('isolated-install-uninstall-ok');})().catch(e=>{console.error(e.stack);process.exitCode=1;});`);
 const env={...process.env,CODEX_DSH_BRIDGE_CONFIG:cfg,CODEX_THREAD_ID:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
 for(const name of ['HARNESS_DIALOGUE_STATE','HARNESS_BRIDGE_STATE','HARNESS_ROUTING_STATE','HARNESS_MAILBOX_STATE','DSH_HOME'])delete env[name];
 const r=spawnSync(process.execPath,[script,root,homes],{env,encoding:'utf8',windowsHide:true,timeout:25000});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/isolated-install-uninstall-ok/);
});
test.after(()=>{const actual=fs.realpathSync(temp);assert.equal(path.dirname(actual).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(actual).startsWith('codex-dsh-distribution-'));fs.rmSync(actual,{recursive:true,force:true});});
