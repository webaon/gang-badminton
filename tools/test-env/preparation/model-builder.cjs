 'use strict';
function stable(x){if(x===null||typeof x!=='object')return JSON.stringify(x);if(Array.isArray(x))return '['+x.map(stable).join(',')+']';return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}';}
function freeze(x){if(x&&typeof x==='object'){for(const v of Object.values(x))freeze(v);Object.freeze(x);}return x;}
// F1: Independent approved reference/schema enforced at launch boundary
const approvedSchema=require('./contracts/approved-plan.schema.json');
function validateReferenceAgainstSchema(copy,schema){
  if(!schema||!schema.properties||!schema.properties.model||!schema.properties.model.const)throw Error('SCHEMA_INCOMPLETE');
  const canonical=schema.properties.model.const;
  if(stable(copy)!==stable(canonical))throw Error('REFERENCE_MISMATCH');
  return true;
}
function validateReference(copy){
if(copy.paths?.new_data_root!=='C:/Users/peepe/gb-test-env-data/gb-env-proof-01'||copy.paths?.new_private_root!=='C:/Users/peepe/gb-test-env-private/gb-env-proof-01')throw Error('INVALID_ROOT');
if(copy.project!=='gb-env-proof-01'||copy.executable!==false||copy.services?.length!==14||copy.networks?.length!==2||copy.anonymous_volume_budget!==0)throw Error('INVALID_CONTRACT');
const nets=new Set(['gb-env-proof-01-net','gb-env-proof-01-deny-net']);if(copy.networks.some(n=>!nets.has(n.name)||n.internal!==true))throw Error('INVALID_NETWORK');
let cpu=0,ram=0;const publications=[];const volumes=new Set(copy.named_volumes);
for(const s of copy.services){if(!/^docker\.io\/[\w./-]+@sha256:[a-f0-9]{64}$/.test(s.image)||!nets.has(s.network)||s.expected_anonymous_volumes!==0||s.image_declared_volume_destinations.length!==0)throw Error('INVALID_SERVICE');if(!Number.isFinite(s.cpu_limit_proposal)||s.cpu_limit_proposal<=0||!Number.isSafeInteger(s.memory_limit_MiB_proposal)||s.memory_limit_MiB_proposal<1)throw Error('INVALID_RESOURCE');cpu+=s.cpu_limit_proposal;ram+=s.memory_limit_MiB_proposal;
for(const p of s.published_ports){if(p.host_ip!=='127.0.0.1'||!({ 'api-gw':56321,supavisor:56329,'deny-sentinel':56325 }[s.service]===p.published))throw Error('INVALID_PUBLISH');publications.push(p.published);}
for(const mount of s.mounts){if(mount.type==='tmpfs'){if(typeof mount.target!=='string'||!mount.target.startsWith('/')||!Number.isSafeInteger(mount.size_MiB)||mount.size_MiB<1)throw Error('INVALID_TMPFS');}else if(mount.type==='volume'){if(!volumes.has(mount.source))throw Error('INVALID_MOUNT');}else if(mount.type==='bind'){if(typeof mount.source!=='string'||mount.source.includes('..')||![copy.paths.new_data_root+'/',copy.paths.new_private_root+'/'].some(p=>mount.source.startsWith(p)))throw Error('INVALID_MOUNT');}else throw Error('INVALID_MOUNT');if(typeof mount.target!=='string'||!mount.target.startsWith('/')||mount.target.includes('..')||mount.target.includes('docker.sock'))throw Error('INVALID_MOUNT');}}
if(cpu>8||ram>8192||publications.length!==3||new Set(publications).size!==3)throw Error('INVALID_BUDGET');return true;}
function createBuilder(approved){const copy=JSON.parse(JSON.stringify(approved));validateReference(copy);validateReferenceAgainstSchema(copy,approvedSchema);const signature=stable(copy);return function(spec){if(stable(spec)!==signature)throw Error('MODEL_DRIFT');return freeze(JSON.parse(JSON.stringify(spec)));};}
module.exports={createBuilder,stable,freeze};
