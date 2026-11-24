'use strict';
const phases=['V3','V4_cutover','V4_persistence','V5','V6'];
// F2: Validate persisted ledger state corruption, finite budgets, and plan identity
function createLedger(budget,store){if(!store||typeof store.load!=='function'||typeof store.commit!=='function')throw Error('STORE_REQUIRED');
// F2: Validate budget structure and all values are finite safe integers > 0
if(!budget||typeof budget!=='object')throw Error('INVALID_BUDGET_TYPE');
const phases=['V3','V4_cutover','V4_persistence','V5','V6'];
for(const phase of phases){if(!budget[phase]||typeof budget[phase]!=='object')throw Error('INVALID_PHASE_BUDGET');
for(const [key,val] of Object.entries(budget[phase])){if(!Number.isSafeInteger(val)||val<1)throw Error('BUDGET_NOT_FINITE_POSITIVE');}}
const caps=structuredClone(budget);
let state=store.load()||{revision:0,phase:0,counts:{},failed:false,planIdentity:'TASK04_DUMMY_ONLY'};
// F2: Validate loaded state structure and all counts are finite nonnegative integers
if(!Number.isSafeInteger(state.revision)||state.revision<0||!Number.isSafeInteger(state.phase)||state.phase<0||state.phase>=phases.length)throw Error('INVALID_LOADED_STATE');
if(typeof state.failed!=='boolean'||typeof state.planIdentity!=='string')throw Error('INVALID_LOADED_STATE');
if(state.planIdentity!=='TASK04_DUMMY_ONLY')throw Error('PLAN_IDENTITY_MISMATCH');
for(const [phase,counts] of Object.entries(state.counts||{})){if(!Number.isSafeInteger(phase) && phase!=='counts') for(const [key,count] of Object.entries(counts)){if(!Number.isSafeInteger(count)||count<0||count>caps[phase]?.[key])throw Error('INVALID_PERSISTED_COUNT');}}
function commit(next){next.revision=state.revision+1;if(!Number.isSafeInteger(next.revision)||next.planIdentity!=='TASK04_DUMMY_ONLY')throw Error('COMMIT_CONTRACT_VIOLATED');if(store.commit(state.revision,structuredClone(next))!==true)throw Error('CAS_CONFLICT');state=next;}
function consume(phase,key,amount=1){if(state.failed||!Number.isSafeInteger(amount)||amount<1||phases[state.phase]!==phase||!Object.hasOwn(caps[phase]||{},key)||typeof caps[phase][key]!=='number'||!Number.isSafeInteger(caps[phase][key])||caps[phase][key]<1)throw Error('OPERATION_DENIED');const current=state.counts[phase]?.[key]||0;if(!Number.isSafeInteger(current)||current<0||current+amount>caps[phase][key])throw Error('BUDGET_EXCEEDED');const next=structuredClone(state);(next.counts[phase]??={})[key]=current+amount;commit(next);}
function advance(){if(state.failed||state.phase>=phases.length-1)throw Error('PHASE_DENIED');const next=structuredClone(state);next.phase++;commit(next);}
function failStop(count){if(state.failed||!Number.isSafeInteger(count)||count<1||count>14)throw Error('FAIL_STOP_DENIED');const next=structuredClone(state);next.failed=true;next.failStopCount=count;commit(next);}
return Object.freeze({consume,advance,failStop,snapshot:()=>structuredClone(state)});}
module.exports={createLedger};
