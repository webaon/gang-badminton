 'use strict';
function createSink(max=12){if(!Number.isSafeInteger(max)||max<1||max>12)throw Error('INVALID_LIMIT');let messages=0;return Object.freeze({count:()=>messages,handle(request){if(request.method==='GET'&&request.url==='/healthz')return {status:200,count:messages};if(request.method!=='POST'||!['/line','/push','/webhook'].includes(request.url))return {status:404};if(messages>=max)return {status:429};messages++;return {status:204,count:messages};}});}
module.exports={createSink};
