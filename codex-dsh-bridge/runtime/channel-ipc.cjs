'use strict';
require('./config.cjs').applyEnvironment();
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const home=process.env.HARNESS_DIALOGUE_STATE||require('./config.cjs').statePath('harness-dialogue');
const pipe='\\\\.\\pipe\\dsh-codex-dialogue-'+crypto.createHash('sha256').update(home.toLowerCase()).digest('hex').slice(0,20);
function call(request,timeout=90000){return new Promise((resolve,reject)=>{
 const socket=net.createConnection(pipe);let text='';const timer=setTimeout(()=>{socket.destroy();reject(Error('Channel request timed out; do not retry a mutation with another operation ID'));},timeout);
 const done=(error,value)=>{clearTimeout(timer);socket.destroy();error?reject(error):resolve(value);};
 socket.on('connect',()=>socket.write(JSON.stringify(request)+'\n'));
 socket.on('data',chunk=>{text+=chunk;if(text.length>2000000)return done(Error('Channel response exceeds limit'));const end=text.indexOf('\n');if(end<0)return;try{const r=JSON.parse(text.slice(0,end));done(r.ok?null:Error(r.error),r.result);}catch(e){done(e);}});
 socket.on('error',e=>done(e));
});}
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
async function bootstrap(){
 try{return await call({command:'ping'},1000);}catch(e){if(!['ENOENT','ECONNREFUSED'].includes(e.code))throw e;}
 const policy=JSON.parse(fs.readFileSync(path.join(home,'channel-policy.json'),'utf8'));
 if(policy.enabled!==true)throw Error('Unified dialogue has not been enabled by the user');
 const lock=path.join(home,'channel-service.lock');
 if(fs.existsSync(lock)){const old=JSON.parse(fs.readFileSync(lock,'utf8'));if(alive(old.pid))throw Error('Channel service exists but is not responding; inspect it before recovery');fs.renameSync(lock,lock+'.stale-'+Date.now());}
 const exe=require('./config.cjs').settings().dshExe;
 const log=fs.openSync(path.join(home,'channel-service.stdout.log'),'a'),err=fs.openSync(path.join(home,'channel-service.stderr.log'),'a');
 const child=spawn(exe,['--expose-internals',path.join(__dirname,'channel-service.cjs')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},cwd:path.resolve(__dirname,'../..'),windowsHide:true,detached:true,stdio:['ignore',log,err]});child.unref();fs.closeSync(log);fs.closeSync(err);
 const deadline=Date.now()+10000;let last;
 while(Date.now()<deadline){try{return await call({command:'ping'},1000);}catch(e){last=e;await new Promise(r=>setTimeout(r,150));}}
 throw Error('Channel service did not start: '+last?.message);
}
async function request(value){await bootstrap();return call(value);}
module.exports={home,pipe,call,request,bootstrap,alive};
