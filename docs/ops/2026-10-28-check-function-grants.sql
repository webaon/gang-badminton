-- อ่านอย่างเดียว: ตรวจว่า anon / authenticated เรียกฟังก์ชันใหม่ไม่ได้ (คาดว่าทุกช่องเป็น false ยกเว้น service_role)
select p.proname,
       pg_get_function_identity_arguments(p.oid) as args,
       has_function_privilege('anon',          p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('service_role',  p.oid, 'execute') as service_role
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('leave_gang','preview_cancel_registration','cancel_registration',
                    'cancel_decision','promote_waitlist','register_to_session')
order by 1, 2;
