 'use strict';
const {project}=require('../output-boundary.cjs');
function evaluate(r){const pass=r.smtpAccepted===true&&r.httpCount===1&&r.recipientRejected===true&&r.deniedBeforeDelegate===true&&r.sentinelHealthy===true&&r.crossNetworkDenied===true;return project({stage:'OFFLINE',status:pass?'PASS':'FAIL'});}
module.exports={evaluate};
