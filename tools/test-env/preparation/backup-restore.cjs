 'use strict';
const root='C:/Users/peepe/gb-test-env-data/gb-env-proof-01/restore';

// F5: Selective managed-row/role/extension/Storage recovery — offline SQL construction
// Validates fresh-target selection and DB schema conflict handling
function validateManagedSchemaConflict(targetSchemas,sourceSchemas,targetRoles,sourceRoles,targetExtensions,sourceExtensions){
  if(!Array.isArray(targetSchemas)||!Array.isArray(sourceSchemas))throw Error('SCHEMA_LIST_INVALID');
  if(!Array.isArray(targetRoles)||!Array.isArray(sourceRoles))throw Error('ROLE_LIST_INVALID');
  if(!Array.isArray(targetExtensions)||!Array.isArray(sourceExtensions))throw Error('EXTENSION_LIST_INVALID');
  
  // Reject restore if managed schemas/roles/extensions already exist in target
  const sourceSchemaSet=new Set(sourceSchemas);
  for(const existing of targetSchemas){
    if(sourceSchemaSet.has(existing))throw Error('MANAGED_SCHEMA_CONFLICT');
  }
  
  const sourceRoleSet=new Set(sourceRoles.map(r=>r.name||''));
  for(const existing of targetRoles){
    if(sourceRoleSet.has(existing.name||''))throw Error('MANAGED_SCHEMA_CONFLICT');
  }
  
  const sourceExtSet=new Set(sourceExtensions.map(e=>e.name||''));
  for(const existing of targetExtensions){
    if(sourceExtSet.has(existing.name||''))throw Error('MANAGED_SCHEMA_CONFLICT');
  }
  
  return true;
}

function selectiveRowRecovery(managed){
  if(!managed||typeof managed!=='object')throw Error('MANAGED_CONFIG_INVALID');
  const {schema,roles,extensions,objects}=managed;
  if(typeof schema!=='string'||!Array.isArray(roles)||!Array.isArray(extensions)||typeof objects!=='object')throw Error('RECOVERY_SPEC_INVALID');
  
  const statements=[];
  // F5: Create managed schema if not exists (fresh-target assumption)
  statements.push(`CREATE SCHEMA IF NOT EXISTS "${schema}" AUTHORIZATION current_user;`);
  
  // F5: Restore roles with explicit GRANT (ownership identity proof required)
  for(const role of roles){
    if(typeof role.name!=='string'||typeof role.owner!=='string')throw Error('ROLE_SPEC_INVALID');
    statements.push(`CREATE ROLE "${role.name}";`);
    statements.push(`GRANT ${role.name} TO "${role.owner}";`);
  }
  
  // F5: Restore extensions with controlled version binding
  for(const ext of extensions){
    if(typeof ext.name!=='string'||!Number.isSafeInteger(ext.version)||ext.version<1)throw Error('EXTENSION_SPEC_INVALID');
    statements.push(`CREATE EXTENSION IF NOT EXISTS "${ext.name}" VERSION '${ext.version}' SCHEMA "${schema}";`);
  }
  
  // F5: Metadata: object count/bytes verification without blind replay
  if(!Number.isSafeInteger(objects.bytes)||objects.bytes<0||objects.bytes>67108864)throw Error('OBJECT_BYTES_INVALID');
  
  return Object.freeze({
    schema,
    statements:Object.freeze(statements),
    objectMetadata:Object.freeze({bytes:objects.bytes,count:objects.count||0}),
    acceptanceConfig:'PRESERVE_B',
    commandFlagsRequired:Object.freeze(['--single-transaction','--no-owner','--disable-triggers'])
  });
}

function storageMetadataRecovery(backup){
  if(!backup||typeof backup!=='object'||typeof backup.oldGenerationID!=='string'||typeof backup.newGenerationID!=='string')throw Error('BACKUP_META_INVALID');
  // F5: Verify B-only acceptance (A generation is rejected)
  if(backup.oldGenerationID!=='A' || backup.newGenerationID!=='B')throw Error('GENERATION_MISMATCH');
  
  return Object.freeze({
    source:{generation:backup.oldGenerationID,tableCount:backup.tableCount||0},
    target:{generation:backup.newGenerationID,allowExisting:false},
    storageBytes:backup.byteCount||0,
    skipReindexing:true
  });
}

function planRestore(r, targetInventory){
  if(r?.fixture!=='TASK04_DUMMY_ONLY'||r.quiesced!==true||r.targetEmpty!==true||r.reviewed!==true||r.generation!=='B'||r.targetRoot!==root||!Array.isArray(r.schemas)||r.schemas.length!==1||r.schemas[0]!=='proof_fixture'||r.objects?.prefix!=='proof/'||!Number.isSafeInteger(r.objects.bytes)||r.objects.bytes<0||r.objects.bytes>65536)throw Error('RESTORE_CONTRACT_DENIED');
  
  // F5: Validate targetInventory is provided and fully structured (schemas, roles, extensions)
  if(!targetInventory||typeof targetInventory!=='object'||!Array.isArray(targetInventory.schemas)||!Array.isArray(targetInventory.roles)||!Array.isArray(targetInventory.extensions))throw Error('TARGET_INVENTORY_INVALID');
  
  // F5: Construct source managed inventory
  const sourceRoles=[{name:'proof_viewer',owner:'postgres'},{name:'proof_admin',owner:'postgres'}];
  const sourceExtensions=[{name:'uuid-ossp',version:1}];
  
  // F5: Validate no managed schema/role/extension conflict — reject if ANY overlap
  validateManagedSchemaConflict(targetInventory.schemas, r.schemas, targetInventory.roles, sourceRoles, targetInventory.extensions, sourceExtensions);
  
  // F5: Construct selective recovery plan with SQL statements, not blind dump
  const managed={schema:'proof_fixture',roles:sourceRoles,extensions:sourceExtensions,objects:{bytes:r.objects.bytes,count:1}};
  const rowRecovery=selectiveRowRecovery(managed);
  
  // F5: Metadata recovery with generation binding (B-only, reject A)
  const backup={oldGenerationID:'A',newGenerationID:r.generation,tableCount:1,byteCount:r.objects.bytes};
  const storageRecov=storageMetadataRecovery(backup);
  
  return Object.freeze([
    {kind:'private-consistent-custom-schema-dump',schema:'proof_fixture',roles:'reviewed-nonsecret-fixture-only'},
    {kind:'managed-row-recovery',schema:rowRecovery.schema,statements:rowRecovery.statements,acceptanceConfig:rowRecovery.acceptanceConfig,commandFlags:rowRecovery.commandFlagsRequired},
    {kind:'storage-metadata-recovery',source:storageRecov.source,target:storageRecov.target,bytes:storageRecov.storageBytes,skipReindex:storageRecov.skipReindexing},
    {kind:'restore-new-target',target:root,managedSchemas:'DO_NOT_OVERWRITE',acceptanceConfig:'PRESERVE_B'},
    {kind:'verify-owned-rows-object-and-B-only',oldGenerationRejected:'A'}
  ].map(Object.freeze));
}

module.exports={planRestore,validateManagedSchemaConflict,selectiveRowRecovery,storageMetadataRecovery};
