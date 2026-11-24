'use strict';
const stages=new Set(['OFFLINE','V0','V1','V2','V3','V4','V5','V6']);const statuses=new Set(['PASS','FAIL','BLOCKED']);
function project(input){if(!input||!stages.has(input.stage)||!statuses.has(input.status))throw new Error('INVALID_METADATA');const out={stage:input.stage,status:input.status};for(const key of ['accepted','revoked','present','synchronized','retained'])if(Object.hasOwn(input,key)){if(typeof input[key]!=='boolean')throw new Error('INVALID_METADATA');out[key]=input[key];}if(Object.hasOwn(input,'count')){if(!Number.isSafeInteger(input.count)||input.count<0||input.count>100000)throw new Error('INVALID_METADATA');out.count=input.count;}return Object.freeze(out);}
async function capture(action,stage='OFFLINE'){try{await action();return project({stage,status:'PASS'});}catch{return project({stage,status:'BLOCKED'});}}
module.exports={project,capture};
