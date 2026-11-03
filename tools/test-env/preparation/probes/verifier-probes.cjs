'use strict';
const {project}=require('../output-boundary.cjs');
const domains=new Set(['auth','gateway','rest','storage','s3','realtime','metrics','pooler-api']);
function assess(record){let ok=record?.fixture==='TASK04_DUMMY_ONLY'&&domains.has(record.domain);const control=record?.beforeA;const same=r=>r&&control&&r.protected===true&&r.authLayer===true&&['endpoint','method','fixture','role'].every(k=>typeof control[k]==='string'&&r[k]===control[k]);const positive=r=>same(r)&&r.status>=200&&r.status<300;const negative=r=>same(r)&&[401,403].includes(r.status)&&['signature-rejected','api-key-rejected'].includes(r.reason);ok=Boolean(ok&&positive(record.beforeA)&&positive(record.newB)&&negative(record.oldA)&&positive(record.afterRestartB)&&negative(record.afterRestartA));return project({stage:'OFFLINE',status:ok?'PASS':'FAIL',accepted:ok,revoked:ok});}
module.exports={assess};
