 'use strict';
// F1 + input shape validation: STRICT — reject missing/nonboolean runtime and unknown context fields
function assertOffline(context){
  if(!context||typeof context!=='object'||typeof context.mode!=='string'||typeof context.fixture!=='string'||typeof context.runtime!=='boolean')throw Error('RUNTIME_NOT_AUTHORIZED');
  if(context.mode!=='offline-fixture'||context.fixture!=='TASK04_DUMMY_ONLY'||context.runtime!==false)throw Error('RUNTIME_NOT_AUTHORIZED');
  // Reject unknown fields in context
  const allowed=new Set(['mode','fixture','runtime']);
  for(const key of Object.keys(context)){if(!allowed.has(key))throw Error('RUNTIME_NOT_AUTHORIZED');}
  return true;
}
function beforeDelegate(context,delegate){
  // Similar to runOffline: validate input mode/fixture, then construct strict context
  if(!context||typeof context!=='object'||typeof context.mode!=='string'||typeof context.fixture!=='string')throw Error('RUNTIME_NOT_AUTHORIZED');
  if(context.mode!=='offline-fixture'||context.fixture!=='TASK04_DUMMY_ONLY')throw Error('RUNTIME_NOT_AUTHORIZED');
  const allowed=new Set(['mode','fixture','runtime']);
  for(const key of Object.keys(context)){if(!allowed.has(key))throw Error('RUNTIME_NOT_AUTHORIZED');}
  if(Object.hasOwn(context,'runtime') && context.runtime!==false)throw Error('RUNTIME_NOT_AUTHORIZED');
  // Create strict context for delegate boundary
  const strictContext={mode:'offline-fixture',fixture:'TASK04_DUMMY_ONLY',runtime:false};
  assertOffline(strictContext);
  if(typeof delegate!=='function')throw Error('INVALID_ADAPTER');
  return delegate();
}
function assertOwned(resource,inventory){if(!resource||!inventory||resource.project!=='gb-env-proof-01'||resource.reparsePoint===true||!inventory.some(r=>r.id===resource.id&&r.name===resource.name&&r.project===resource.project&&r.createdBy===resource.createdBy))throw Error('IDENTITY_MISMATCH');return true;}
module.exports={assertOffline,beforeDelegate,assertOwned};
