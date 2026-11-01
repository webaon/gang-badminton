/** ADR-015 R-roles-2c: announcements keep preset behavior; scheduler gains gang-wide statistics. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { pool, createUser, addGangMember, asRole } from '../helpers/db';
import { can } from '@/domain/permissions/can';
import { ACTIONS, type Action } from '@/domain/permissions/types';
import { DELEGABLE_ACTIONS, ROLE_PRESETS } from '@/domain/permissions/delegable';

let gang: string;
let otherGang: string;
let owner: string;
let admin: string;
let orgAdmin: string;
let scheduler: string;
let treasurer: string;
let member: string;
let outsider: string;
let foreignScheduler: string;
let schedulerMember: string;

beforeAll(async () => {
  owner = await createUser('stats-owner');
  const { rows: [g] } = await pool.query<{ id: string; org_id: string }>(
    `select id,org_id from public.create_gang($1,$2)`, [owner, `stats-${crypto.randomUUID()}`],
  );
  gang = g.id;
  admin = await createUser('stats-admin');
  orgAdmin = await createUser('stats-org-admin');
  scheduler = await createUser('stats-scheduler');
  treasurer = await createUser('stats-treasurer');
  member = await createUser('stats-member');
  outsider = await createUser('stats-outsider');
  await pool.query(`insert into public.gang_members(gang_id,user_id,role) values($1,$2,'admin')`,[gang,admin]);
  await pool.query(`insert into public.organization_members(org_id,user_id,role) values($1,$2,'admin')`,[g.org_id,orgAdmin]);
  schedulerMember = await addGangMember(gang,scheduler);
  const t = await addGangMember(gang,treasurer);
  const m = await addGangMember(gang,member);
  await pool.query(`select public.assign_gang_role($1,$2,'scheduler',$3)`,[gang,scheduler,owner]);
  await pool.query(`select public.assign_gang_role($1,$2,'treasurer',$3)`,[gang,treasurer,owner]);
  await pool.query(`update public.gangs set features=features||'{"statistics":true}'::jsonb where id=$1`,[gang]);
  await pool.query(`insert into public.member_statistics(gang_id,gang_member_id) values($1,$2),($1,$3),($1,$4)`,[gang,schedulerMember,t,m]);
  await pool.query(`insert into public.announcements(gang_id,title,body,published_at) values($1,'public','body',now()),($1,'draft','body',null)`,[gang]);

  const otherOwner = await createUser('stats-other-owner');
  const { rows:[og] } = await pool.query<{id:string}>(`select id from public.create_gang($1,$2)`,[otherOwner,`other-stats-${crypto.randomUUID()}`]);
  otherGang = og.id;
  foreignScheduler = await createUser('foreign-scheduler');
  await addGangMember(otherGang,foreignScheduler);
  await pool.query(`select public.assign_gang_role($1,$2,'scheduler',$3)`,[otherGang,foreignScheduler,otherOwner]);
},30_000);
afterAll(async () => { await pool.end(); });

async function tx<T>(fn:(c:PoolClient)=>Promise<T>) {
  const c=await pool.connect();
  try {await c.query('begin');return await fn(c);}finally{await c.query('rollback');c.release();}
}
async function claims(c:PoolClient,uid:string) {
  await c.query(`select set_config('request.jwt.claims',$1,true)`,[JSON.stringify({sub:uid,role:'authenticated'})]);
}
const visible = (uid:string,table:string) => asRole('authenticated',uid,async c=>
  Number((await c.query<{n:string}>(`select count(*)::text n from public.${table} where gang_id=$1`,[gang])).rows[0].n),
);

it('catalog/TS/DB: statistics.view.all is delegable, belongs to scheduler only, and TS gates statistics feature',async()=>{
  const action='statistics.view.all' as Action;
  expect(ACTIONS as readonly string[]).toContain(action);
  expect(DELEGABLE_ACTIONS as readonly string[]).toContain(action);
  expect(ROLE_PRESETS.scheduler as readonly string[]).toContain(action);
  expect(ROLE_PRESETS.treasurer as readonly string[]).not.toContain(action);
  expect(can({role:'member',features:{statistics:true},extra:ROLE_PRESETS.scheduler},action)).toBe(true);
  expect(can({role:'member',features:{statistics:false},extra:ROLE_PRESETS.scheduler},action)).toBe(false);
  expect(can({role:'member',extra:ROLE_PRESETS.scheduler},action)).toBe(false);
  expect(can({role:'member',features:{statistics:true}},action)).toBe(false);
  for(const role of ['owner','admin'] as const)expect(can({role,features:{statistics:true}},action)).toBe(true);
  const {rows:[r]}=await pool.query<{delegable:boolean;checked:boolean;perms:string[]}>(
    `select public.is_delegable_action($1) delegable,public.permissions_are_delegable(array[$1]::text[]) checked,
      (select permissions from public.gang_roles where key='scheduler' and gang_id is null and deleted_at is null) perms`,[action]);
  expect(r.delegable).toBe(true);expect(r.checked).toBe(true);expect(r.perms).toContain(action);
});

it('RLS statistics: scheduler/owner/admin/orgAdmin see all; ordinary member/treasurer see self; outsider/foreign scheduler/anon see nothing',async()=>{
  for(const uid of [owner,admin,orgAdmin,scheduler])expect(await visible(uid,'member_statistics')).toBe(3);
  for(const uid of [member,treasurer])expect(await visible(uid,'member_statistics')).toBe(1);
  for(const uid of [outsider,foreignScheduler])expect(await visible(uid,'member_statistics')).toBe(0);
  expect(await asRole('anon',null,async c=>{
    try {await c.query(`select 1 from public.member_statistics where gang_id=$1`,[gang]);return 'allowed';}
    catch(e){return (e as {code:string}).code;}
  })).toBe('42501');
});

it('statistics flag is enforced by RLS, not permission helpers; old admin and self access stay unchanged',async()=>{
  for(const feature of [false,null])await tx(async c=>{
    await c.query(`update public.gangs set features=case when $2::boolean is null then features-'statistics' else features||jsonb_build_object('statistics',$2::boolean) end where id=$1`,[gang,feature]);
    await claims(c,scheduler);
    const {rows:[r]}=await c.query<{actor:boolean;single:boolean;set:boolean}>(
      `select public.actor_has_permission($1,$2,'statistics.view.all') actor,
       public.has_gang_permission($1,'statistics.view.all') single,
       $1::uuid=any(public.gangs_with_permission('statistics.view.all')) "set"`,[gang,scheduler]);
    // Helpers describe role permissions only; feature enforcement belongs to this resource policy.
    expect(r).toEqual({actor:true,single:true,set:true});
    await c.query('set local role authenticated');
    expect(Number((await c.query<{n:string}>(`select count(*)::text n from public.member_statistics where gang_id=$1`,[gang])).rows[0].n)).toBe(1);
    // Legacy admin access did not use the flag; changing it is separate hardening scope.
    await claims(c,admin);
    expect(Number((await c.query<{n:string}>(`select count(*)::text n from public.member_statistics where gang_id=$1`,[gang])).rows[0].n)).toBe(3);
  });
});

it('permission helpers remain feature-neutral and the feature-set scan is an uncorrelated InitPlan executed once',async()=>{
  const {rows}=await pool.query<{proname:string;prosrc:string}>(`select proname,prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname=any($1::text[])`,[['has_gang_permission','actor_has_permission','gangs_with_permission']]);
  expect(rows).toHaveLength(3);
  for(const r of rows)expect(r.prosrc,r.proname).not.toMatch(/statistics|features|delegated_action_enabled/);
  await asRole('authenticated',scheduler,async c=>{
    const {rows:[r]}=await c.query(`explain (analyze,format json) select * from public.member_statistics where gang_id=$1`,[gang]);
    const nodes: Record<string,unknown>[]=[];
    function visit(v:unknown){
      if(Array.isArray(v)){for(const x of v)visit(x);return;}
      if(v && typeof v==='object'){
        const o=v as Record<string,unknown>;
        if(o['Parent Relationship']==='InitPlan' && JSON.stringify(o).includes('"Relation Name":"gangs"') && JSON.stringify(o).includes('statistics'))nodes.push(o);
        for(const x of Object.values(o))visit(x);
      }
    }
    visit(r['QUERY PLAN']);
    expect(nodes.length).toBeGreaterThan(0);
    for(const n of nodes)expect(n['Actual Loops']).toBe(1);
  });
});

it('revoke/leave scheduler removes cross-member visibility immediately; reinstating member does not restore role',async()=>{
  await tx(async c=>{
    await c.query(`select public.revoke_gang_role($1,$2,'scheduler',$3)`,[gang,scheduler,owner]);
    await claims(c,scheduler);await c.query('set local role authenticated');
    expect(Number((await c.query<{n:string}>(`select count(*)::text n from public.member_statistics where gang_id=$1`,[gang])).rows[0].n)).toBe(1);
  });
  await tx(async c=>{
    await c.query(`select public.leave_gang($1,$2,'stats-exit')`,[gang,scheduler]);
    await claims(c,scheduler);await c.query('set local role authenticated');
    expect(Number((await c.query<{n:string}>(`select count(*)::text n from public.member_statistics where gang_id=$1`,[gang])).rows[0].n)).toBe(0);
    await c.query('reset role');
    await c.query(`update public.gang_members set deleted_at=null,deleted_by=null where id=$1`,[schedulerMember]);
    await c.query('set local role authenticated');
    expect(Number((await c.query<{n:string}>(`select count(*)::text n from public.member_statistics where gang_id=$1`,[gang])).rows[0].n)).toBe(1);
  });
});

describe('announcements: no existing preset receives announcement.manage',()=>{
  it('presets read published only and cannot insert/update/delete; admin/orgAdmin unchanged',async()=>{
    expect(ROLE_PRESETS.scheduler as readonly string[]).not.toContain('announcement.manage');
    expect(ROLE_PRESETS.treasurer as readonly string[]).not.toContain('announcement.manage');
    for(const uid of [owner,admin,orgAdmin])expect(await visible(uid,'announcements')).toBe(2);
    for(const uid of [scheduler,treasurer,member]){
      expect(await visible(uid,'announcements')).toBe(1);
      for(const sql of [
        `update public.announcements set body=body where gang_id=$1`,
        `delete from public.announcements where gang_id=$1`,
      ])expect(await asRole('authenticated',uid,async c=>(await c.query(sql,[gang])).rowCount)).toBe(0);
      await expect(asRole('authenticated',uid,c=>c.query(`insert into public.announcements(gang_id,title,body) values($1,'blocked','body')`,[gang]))).rejects.toMatchObject({code:'42501'});
    }
    expect(await visible(outsider,'announcements')).toBe(0);
  });
  it('policy actually uses announcement.manage: custom test-only bundle can manage drafts, but cannot grant roles or access statistics',async()=>{
    await tx(async c=>{
      const {rows:[r]}=await c.query<{id:string}>(`insert into public.gang_roles(gang_id,key,name,permissions) values($1,'announcer','announcer',array['announcement.manage']::text[]) returning id`,[gang]);
      expect(r.id).toBeTruthy();
      await c.query(`select public.assign_gang_role($1,$2,'announcer',$3)`,[gang,member,owner]);
      await claims(c,member);await c.query('set local role authenticated');
      expect((await c.query(`select 1 from public.announcements where gang_id=$1`,[gang])).rowCount).toBe(2);
      expect((await c.query(`update public.announcements set body=body where gang_id=$1`,[gang])).rowCount).toBe(2);
      expect((await c.query(`insert into public.announcements(gang_id,title,body) values($1,'allowed','body')`,[gang])).rowCount).toBe(1);
      expect(Number((await c.query<{n:string}>(`select count(*)::text n from public.member_statistics where gang_id=$1`,[gang])).rows[0].n)).toBe(1);
      expect((await c.query<{v:boolean}>(`select public.has_gang_permission($1,'gang.member.manage') v`,[gang])).rows[0].v).toBe(false);
    });
  });
});
