 'use strict';
// F4: Pinned admitted addresses retained through transport boundary
function admit(request,contract){if(!request||typeof request.url!=='string'||request.url.includes('%')||request.redirect===true||request.proxy)throw Error('DESTINATION_DENIED');let u;try{u=new URL(request.url);}catch{throw Error('DESTINATION_DENIED');}const row=Object.hasOwn(contract,u.hostname)?contract[u.hostname]:null;const port=Number(u.port||80);if(u.protocol!=='http:'||u.username||u.password||!row||!row.ports.includes(port)||!Array.isArray(request.resolved)||request.resolved.length===0||request.resolved.some(ip=>!row.ips.includes(ip)))throw Error('DESTINATION_DENIED');// F4: Freeze the admitted address set so transport cannot re-resolve
const addresses=Object.freeze([...request.resolved]);return Object.freeze({hostname:u.hostname,port,path:u.pathname+u.search,redirect:'error',addresses});}
function dispatch(request,contract,delegate){const admitted=admit(request,contract);if(typeof delegate!=='function')throw Error('INVALID_ADAPTER');// F4: Transport receives pinned addresses, cannot bypass by re-resolving hostname
return delegate(admitted);}
module.exports={admit,dispatch};
