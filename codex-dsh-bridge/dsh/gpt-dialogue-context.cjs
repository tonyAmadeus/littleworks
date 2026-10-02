'use strict';
const META_KEY='dsh/gpt-dialogue-source';
function validateSource(source){
 if(!source||source.version!==1||typeof source.sessionId!=='string'||!/^[-a-zA-Z0-9_]{1,160}$/.test(source.sessionId)||typeof source.callId!=='string'||!/^[-a-zA-Z0-9_:]{1,200}$/.test(source.callId))throw Error('GPT dialogue requires the real DSH tool execution context');
 return {version:1,sessionId:source.sessionId,callId:source.callId};
}
function sourceFromExecution(execution){return validateSource({version:1,sessionId:execution?.agent?.session?.id,callId:execution?.callId});}
module.exports={META_KEY,validateSource,sourceFromExecution};
