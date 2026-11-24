 'use strict';
const {assertOffline}=require('./target-guard.cjs');const {createBuilder}=require('./model-builder.cjs');const {project}=require('./output-boundary.cjs');
function runOffline(context,spec,approved){
  // Launcher validates mode/fixture input and rejects runtime modes + unknown fields
  // Then creates strict offline context {mode,fixture,runtime:false} for assertOffline
  if(!context||typeof context!=='object'||typeof context.mode!=='string'||typeof context.fixture!=='string')throw Error('RUNTIME_NOT_AUTHORIZED');
  if(context.mode!=='offline-fixture'||context.fixture!=='TASK04_DUMMY_ONLY')throw Error('RUNTIME_NOT_AUTHORIZED');
  // Reject runtime modes (V0–V6) or explicit runtime=true
  const allowed=new Set(['mode','fixture','runtime']);
  for(const key of Object.keys(context)){if(!allowed.has(key))throw Error('RUNTIME_NOT_AUTHORIZED');}
  if(Object.hasOwn(context,'runtime') && context.runtime!==false)throw Error('RUNTIME_NOT_AUTHORIZED');
  
  // Launcher constructs strict offline context (runtime is always false, never caller-supplied)
  const offlineContext={mode:'offline-fixture',fixture:'TASK04_DUMMY_ONLY',runtime:false};
  assertOffline(offlineContext);
  
  const model=createBuilder(approved)(spec);
  return project({stage:'OFFLINE',status:'PASS',count:model.services.length});
}
module.exports={runOffline};
if(require.main===module){try{if(process.argv.length!==3||process.argv[2]!=='--offline-check')throw Error('RUNTIME_NOT_AUTHORIZED');const fixture=require('./fixtures/nonsecret-model.json');console.log(JSON.stringify(runOffline(fixture.context,fixture.model,fixture.model)));}catch{console.log(JSON.stringify(project({stage:'OFFLINE',status:'BLOCKED'})));process.exitCode=2;}}
