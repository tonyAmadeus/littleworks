'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
// Readers on Windows can briefly omit FILE_SHARE_DELETE. Preserve the target
// and retry the same atomic replacement, never truncate or rewrite the original.
function replace(source,target,{io=fs,pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms),attempts=25}={}){
 for(let n=0;;n++){try{io.renameSync(source,target);return;}catch(e){if(!['EPERM','EACCES','EBUSY'].includes(e.code)||n>=attempts-1)throw e;pause(25);}}
}
function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2),'utf8');replace(tmp,file);}
module.exports={replace,atomic};
