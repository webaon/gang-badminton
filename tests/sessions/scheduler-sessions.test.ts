/** ADR-015 R-roles-2b: scheduler session policy + existing actor gates.
 * No new actor restrictions on legacy service-only functions without role checks.
 * Fixtures with waitlists use in_play (sweep cron only scans open).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { pool, createUser, createFixture, addGangMember, asRole, runConcurrently } from '../helpers/db';
import { can } from '@/domain/permissions/can';
import { ROLE_PRESETS } from '@/domain/permissions/delegable';

afterAll(async () => { await pool.end(); });

async function setup() {
  const owner = await createUser('scheduler-owner');
  const f = await createFixture({ ownerId: owner, maxPlayers: 1 });
  await pool.query(`insert into public.gang_members(gang_id,user_id,role) values($1,$2,'owner')`,[f.gangId,owner]);
  const scheduler = await createUser('scheduler');
  const plain = await createUser('plain');
  const treasurer = await createUser('treasurer');
  const outsider = await createUser('outsider');
  const schedulerMember = await addGangMember(f.gangId, scheduler);
  await addGangMember(f.gangId, plain);
  await addGangMember(f.gangId, treasurer);
  await pool.query(`select public.assign_gang_role($1,$2,'scheduler',$3)`, [f.gangId,scheduler,owner]);
  await pool.query(`select public.assign_gang_role($1,$2,'treasurer',$3)`, [f.gangId,treasurer,owner]);
  const { rows: [org] } = await pool.query<{org_id: string}>(`select org_id from public.gangs where id=$1`,[f.gangId]);
  const orgAdmin = await createUser('scheduler-orgadmin');
  await pool.query(`insert into public.organization_members(org_id,user_id,role) values($1,$2,'admin')`,[org.org_id,orgAdmin]);
  // Register a real member; all waitlist fixtures stay in_play to be cron-ineligible.
  const { rows: [reg] } = await pool.query<{id:string}>(`select id from public.register_to_session($1,$2)`,[f.sessionId,plain]);
  await pool.query(`select public.transition_session($1,'in_play',$2)`,[f.sessionId,owner]);
  const {rows:[wait]} = await pool.query<{id:string}>(`insert into public.session_registrations(session_id,guest_name,status,ordering) values($1,'waiting','waitlist',1) returning id`,[f.sessionId]);
  const {rows:[draft]} = await pool.query<{id:string}>(`insert into public.sessions(gang_id,title,starts_at,ends_at,max_players,snapshot) values($1,'draft',now()+interval '2 days',now()+interval '3 days',8,'{}') returning id`,[f.gangId]);
  // Games: 8 distinct guests so an insert probe does real work instead of failing a constraint.
  const guests:string[]=[];
  for(let i=0;i<8;i++) {
    const {rows:[r]}=await pool.query<{id:string}>(`insert into public.session_registrations(session_id,guest_name,status,ordering) values($1,$2,'confirmed',$3) returning id`,[draft.id,`player-${i}`,i+1]); guests.push(r.id);
  }
  await pool.query(`insert into public.games(session_id,court_no,player1_registration_id,player2_registration_id,player3_registration_id,player4_registration_id) values($1,1,$2,$3,$4,$5)`,[draft.id,...guests.slice(0,4)]);
  await pool.query(`insert into public.session_invite_tokens(session_id,token_hash,expires_at) values($1,extensions.digest(extensions.gen_random_bytes(32),'sha256'),now()+interval '1 day')`,[draft.id]);
  return {...f,owner,scheduler,plain,treasurer,outsider,orgAdmin,schedulerMember,reg:reg.id,wait:wait.id,draft:draft.id,guests};
}
type World=Awaited<ReturnType<typeof setup>>;
let wp:Promise<World>|undefined;
const world=()=>wp??=setup();

async function rollback<T>(fn:(c:PoolClient)=>Promise<T>) {
  const c=await pool.connect();
  try {await c.query('begin'); return await fn(c);} finally {await c.query('rollback');c.release();}
}
async function operation(uid:string,sql:string,params:unknown[]=[]) {
  return asRole('authenticated',uid,async c=> {
    try {return (await c.query(sql,params)).rowCount ?? 0;} catch(e) {if((e as {code:string}).code==='42501')return -1;throw e;}
  });
}

// These literal cells are tested RED before applying 0052; the old golden remains the no-regression matrix for all old identities.
describe('R-roles-2b scheduler policy cells',()=>{
  it('scheduler can create draft/update session; non-scheduler cannot; insert non-draft stays denied',async()=>{
    const w=await world();
    const insert=`insert into public.sessions(gang_id,title,starts_at,ends_at,max_players,status,snapshot) values($1,'probe',now()+interval '2 days',now()+interval '3 days',4,$2,'{}')`;
    expect(await operation(w.scheduler,insert,[w.gangId,'draft'])).toBe(1);
    expect(await operation(w.scheduler,insert,[w.gangId,'open'])).toBe(-1);
    for(const uid of [w.plain,w.treasurer,w.outsider])expect(await operation(uid,insert,[w.gangId,'draft'])).toBe(-1);
    for(const uid of [w.owner,w.scheduler])expect(await operation(uid,`update public.sessions set title=title where id=$1`,[w.draft])).toBe(1);
    for(const uid of [w.plain,w.treasurer,w.outsider,w.orgAdmin])expect(await operation(uid,`update public.sessions set title=title where id=$1`,[w.draft])).toBe(0);
  });
  it('scheduler invite/game CRUD goes through same admin cells; orgAdmin preserved despite sessions SELECT hiding rows',async()=>{
    const w=await world();
    const defs:[string,unknown[]][]=[
      [`select 1 from public.session_invite_tokens where session_id=$1`,[w.draft]],
      [`insert into public.session_invite_tokens(session_id,token_hash,expires_at) values($1,extensions.digest(extensions.gen_random_bytes(32),'sha256'),now()+interval '1 day')`,[w.draft]],
      [`update public.session_invite_tokens set expires_at=expires_at where session_id=$1`,[w.draft]],
      [`delete from public.session_invite_tokens where session_id=$1`,[w.draft]],
      [`insert into public.games(session_id,court_no,player1_registration_id,player2_registration_id,player3_registration_id,player4_registration_id) values($1,2,$2,$3,$4,$5)`,[w.draft,...w.guests.slice(4)]],
      [`update public.games set court_no=court_no where session_id=$1`,[w.draft]],
      [`delete from public.games where session_id=$1`,[w.draft]],
    ];
    for(const [sql,params]of defs) {
      for(const uid of [w.owner,w.scheduler,w.orgAdmin])expect(await operation(uid,sql,params),`${sql} uid=${uid}`).toBe(1);
      for(const uid of [w.plain,w.treasurer,w.outsider])expect(await operation(uid,sql,params),sql).toBeLessThanOrEqual(0);
    }
  });
  it('scheduler can waive cancellation and preview others; treasurer/plain outsider cannot waive; self preview unchanged',async()=>{
    const w=await world();
    for(const uid of [w.owner,w.scheduler,w.orgAdmin])await rollback(async c=>{
      await expect(c.query(`select public.preview_cancel_registration($1,$2)`,[w.reg,uid])).resolves.toBeDefined();
      await expect(c.query(`select public.cancel_registration($1,$2,'scheduler-test',true,'test')`,[w.reg,uid])).resolves.toBeDefined();
    });
    for(const uid of [w.plain,w.treasurer,w.outsider])await expect(rollback(c=>c.query(`select public.cancel_registration($1,$2,'scheduler-test',true,'test')`,[w.reg,uid]))).rejects.toThrow(/FORBIDDEN/);
    await expect(rollback(c=>c.query(`select public.preview_cancel_registration($1,$2)`,[w.reg,w.plain]))).resolves.toBeDefined();
  });
  it('admin-pick promotion: scheduler permitted, others denied; capacity guard unchanged',async()=>{
    const w=await world();
    for(const uid of [w.owner,w.scheduler,w.orgAdmin])await expect(rollback(c=>c.query(`select * from public.promote_waitlist($1,null,$2,'scheduler-test',$3)`,[w.sessionId,uid,w.wait]))).rejects.toThrow(/SESSION_FULL/);
    for(const uid of [w.plain,w.treasurer,w.outsider])await expect(rollback(c=>c.query(`select * from public.promote_waitlist($1,null,$2,'scheduler-test',$3)`,[w.sessionId,uid,w.wait]))).rejects.toThrow(/FORBIDDEN/);
  });
  it('sessions_with_permission matches is_session_admin OR delegated for all actions, including hidden/deleted sessions',async()=>{
    const w=await world();
    for(const uid of [w.owner,w.scheduler,w.orgAdmin,w.plain,w.treasurer,w.outsider])await asRole('authenticated',uid,async c=>{
      for(const action of ['session.create','session.update','game.manage','session.invite.manage','payment.verify','gang.member.manage']){
        const {rows:[r]}=await c.query<{actual:boolean;expected:boolean}>(`select $1::uuid=any(public.sessions_with_permission($2)) actual, public.has_gang_permission($3,$2) expected`,[w.draft,action,w.gangId]);
        expect(r.actual,`${uid} ${action}`).toBe(r.expected);
      }
    });
    await rollback(async c=>{
      await c.query(`update public.sessions set deleted_at=now() where id=$1`,[w.draft]);
      await c.query(`select set_config('request.jwt.claims',$1,true)`,[JSON.stringify({sub:w.scheduler,role:'authenticated'})]);
      const {rows:[r]}=await c.query<{v:boolean}>(`select $1::uuid=any(public.sessions_with_permission('game.manage')) v`,[w.draft]);expect(r.v).toBe(false);
    });
  });
  it('service_role scheduler: real promotion and atomic cancel+selected promotion succeed; preview stays read-only',async()=>{
    const w=await world();
    await rollback(async c=>{
      // Free space only inside this transaction: no cron-visible eligibility window.
      await c.query(`update public.sessions set max_players=max_players+1 where id=$1`,[w.sessionId]);
      await c.query('set local role service_role');
      const {rows}=await c.query<{id:string;status:string}>(`select * from public.promote_waitlist($1,null,$2,'scheduler-positive',$3)`,[w.sessionId,w.scheduler,w.wait]);
      expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({id:w.wait,status:'confirmed'});
    });
    await rollback(async c=>{
      await c.query('set local role service_role');
      await c.query(`select public.cancel_registration($1,$2,'scheduler-replace',true,'replace',$3)`,[w.reg,w.scheduler,w.wait]);
      const {rows}=await c.query<{id:string;status:string}>(`select id,status from public.session_registrations where id=any($1::uuid[])`,[[w.reg,w.wait]]);
      expect(Object.fromEntries(rows.map(r=>[r.id,r.status]))).toEqual({[w.reg]:'cancelled',[w.wait]:'confirmed'});
    });
    await rollback(async c=>{
      await c.query('set transaction read only');
      await c.query('set local role service_role');
      await expect(c.query(`select public.preview_cancel_registration($1,$2)`,[w.reg,w.scheduler])).resolves.toBeDefined();
    });
  });
  it('legacy check-in/no-show/shuttle functions remain usable by the scheduler service path without lock/body changes',async()=>{
    const w=await world();
    await rollback(async c=>{
      await c.query('set local role service_role');
      const {rows:[r]}=await c.query<{status:string}>(`select (public.check_in_registration($1,$2,'scheduler-checkin')).status status`,[w.reg,w.scheduler]);
      expect(r.status).toBe('checked_in');
    });
    await rollback(async c=>{
      await c.query('set local role service_role');
      const {rows:[r]}=await c.query<{status:string}>(`select (public.mark_no_show($1,$2,'scheduler-no-show')).status status`,[w.reg,w.scheduler]);
      expect(r.status).toBe('no_show');
    });
    await rollback(async c=>{
      await c.query('set local role service_role');
      await c.query(`select public.transition_session($1,'open',$2)`,[w.draft,w.scheduler]);
      await c.query(`select public.transition_session($1,'in_play',$2)`,[w.draft,w.scheduler]);
      const {rows:[g]}=await c.query<{id:string}>(`select id from public.games where session_id=$1`,[w.draft]);
      const {rows:[r]}=await c.query<{v:string}>(`select (public.update_game_shuttles($1,2,$2,'scheduler-shuttle')).shuttles_used::text v`,[g.id,w.scheduler]);
      expect(Number(r.v)).toBe(2);
    });
  });
  it('0052 copied actor-checked bodies differ from latest originals only in three permission predicates (lock order unchanged)',()=>{
    const dir=join(process.cwd(),'supabase/migrations');
    const newest=readFileSync(join(dir,'20260818000052_session_permissions.sql'),'utf8');
    const extract=(s:string,name:string)=>{
      const start=s.indexOf(`create or replace function public.${name}(`);
      expect(start).toBeGreaterThanOrEqual(0);
      return s.slice(start,s.indexOf('$$;',start)+3).replaceAll('\r\n','\n');
    };
    for(const [file,name,action] of [
      ['20260818000045_notify_via_fanout.sql','promote_waitlist','registration.promote.other'],
      ['20260818000043_preview_cancel_registration.sql','cancel_registration','registration.cancel.other'],
      ['20260818000043_preview_cancel_registration.sql','preview_cancel_registration','registration.cancel.other'],
    ]){
      const old=extract(readFileSync(join(dir,file),'utf8'),name);
      expect(extract(newest,name),name).toBe(old.replace('public.actor_is_gang_admin(v_session.gang_id, p_actor_id)',`public.actor_has_permission(v_session.gang_id, p_actor_id, '${action}')`));
    }
  });
  it('revocation takes effect next statement; scheduler cannot get finance/member-management through this change',async()=>{
    const w=await world();
    await rollback(async c=>{
      await c.query(`select set_config('request.jwt.claims',$1,true)`,[JSON.stringify({sub:w.scheduler,role:'authenticated'})]);
      expect((await c.query<{v:boolean}>(`select $1::uuid=any(public.sessions_with_permission('game.manage')) v`,[w.draft])).rows[0].v).toBe(true);
      await c.query(`select public.revoke_gang_role($1,$2,'scheduler',$3)`,[w.gangId,w.scheduler,w.owner]);
      expect((await c.query<{v:boolean}>(`select $1::uuid=any(public.sessions_with_permission('game.manage')) v`,[w.draft])).rows[0].v).toBe(false);
    });
    expect(can({role:'member',extra:ROLE_PRESETS.scheduler},'session.create')).toBe(true);
    expect(can({role:'member',extra:ROLE_PRESETS.scheduler},'gang.member.manage')).toBe(false);
    expect(can({role:'member',extra:ROLE_PRESETS.scheduler},'payment.verify')).toBe(false);
  });
});

it('scheduler cancel/promote/sweep concurrency ×20: no deadlock, no overbooking, notifications idempotent',async()=>{
  const w=await world();
  for(let round=0;round<20;round++){
    const f=await createFixture({ownerId:w.owner,maxPlayers:1});
    await pool.query(`insert into public.gang_members(gang_id,user_id,role) values($1,$2,'owner')`,[f.gangId,w.owner]);
    await addGangMember(f.gangId,w.scheduler);await addGangMember(f.gangId,w.plain);
    await pool.query(`select public.assign_gang_role($1,$2,'scheduler',$3)`,[f.gangId,w.scheduler,w.owner]);
    const {rows:[reg]}=await pool.query<{id:string}>(`select id from public.register_to_session($1,$2)`,[f.sessionId,w.plain]);
    // Full open fixture is not eligible for sweep until cancellation. There is no transient free seat before the transaction.
    const {rows:[wait]}=await pool.query<{id:string}>(`insert into public.session_registrations(session_id,guest_name,status,ordering) values($1,'waiting','waitlist',1) returning id`,[f.sessionId]);
    const res=await runConcurrently(3,(c,k)=>k===0
      ?c.query(`select public.cancel_registration($1,$2,'scheduler-race',true,'test')`,[reg.id,w.scheduler])
      :k===1?c.query(`select * from public.promote_waitlist($1,null,$2,'scheduler-race',$3)`,[f.sessionId,w.scheduler,wait.id])
      :c.query(`select public.sweep_waitlist()`));
    for(const r of res)if(r.status==='rejected'){
      expect((r.reason as {code:string}).code).not.toBe('40P01');
      expect((r.reason as Error).message).toMatch(/SESSION_FULL|INVALID_REGISTRATION_TRANSITION/);
    }
    expect(res[0].status).toBe('fulfilled');expect(res[2].status).toBe('fulfilled');
    const {rows:[r]}=await pool.query<{occupied:number;promoted:string}>(`select public.session_occupied_seats($1) occupied,(select count(*)::text from public.event_logs where session_id=$1 and event_type='waitlist.promoted') promoted`,[f.sessionId]);
    expect(r.occupied).toBe(1);expect(r.promoted).toBe('1');
  }
},120_000);
