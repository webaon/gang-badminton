 'use strict';
const {beforeDelegate,assertOwned}=require('./target-guard.cjs');
function planCleanup(resources,inventory,context){
  // Validate context and create strict offline context before proceeding
  beforeDelegate(context,()=>true); // Validate without delegation
  if(!Array.isArray(resources)||resources.length>14)throw Error('CLEANUP_DENIED');
  const seen=new Set();
  const plan=resources.map(r=>{assertOwned(r,inventory);if(!/^[a-f0-9]{64}$/.test(r.id)||r.createdBy!=='TASK04_DUMMY_ONLY'||seen.has(r.id))throw Error('CLEANUP_DENIED');seen.add(r.id);return Object.freeze({kind:'remove-exact-owned-container',id:r.id,volumes:false});});
  return Object.freeze(plan);
}
module.exports={planCleanup};
