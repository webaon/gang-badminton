# Rate limits — ทางเข้าสาธารณะทุกทาง

> **[WO-5.C]** baseline §Security Checklist: *"Rate limit บน endpoint ที่ guest/public เรียกได้ทุกตัว"*
>
> ตัวนับคือ `check_rate_limit()` (migration `0008`) — fixed window ใน Postgres, atomic ด้วย
> `ON CONFLICT DO UPDATE` · ❌ **ห้ามสร้างกลไก/ตารางนับใหม่**
>
> helper กลาง: `server/security/rate-limit.ts`
> · `enforceRateLimit()` → โยน `RATE_LIMITED` (ใช้ใน server action)
> · `withinRateLimit()` → คืน boolean (ใช้ใน route handler ที่ต้องตอบ redirect เอง)

---

## ตารางเพดาน

| ทางเข้า | ต้องล็อกอิน | key นับตาม | เพดาน | เหตุผลของตัวเลข |
|---|---|---|---|---|
| `searchGangs()` (`/discover`) · scope `discovery:search` | ❌ | IP | **30 / นาที** | trgm query บนตารางก๊วนทั้งแพลตฟอร์ม — งานหนักที่ใครก็ยิงได้ · 30/นาทีพอสำหรับคนพิมพ์ค้นจริง (พิมพ์ทีละตัวก็ไม่ถึง) |
| ลงชื่อ guest ผ่านลิงก์เชิญ · scope `guest:<action>` | ❌ | IP + `session_id` | **10 / ชม.** | ของเดิมตั้งแต่ WO-2.5 — กันยิงลงชื่อรัวจนเต็มนัด |
| `/guest/<id>/claim` · scope `guest:claim` | ❌ | IP + `registration_id` | **10 / ชม.** | รับ token จาก query ⇒ ไม่มีเพดาน = เดา token ได้ไม่จำกัด |
| `/auth/callback` · scope `auth:callback` | ❌ | IP | **30 / ชม.** | แลก code กับ Supabase ทุกครั้ง · ตั้งหลวมพอให้คนหลัง NAT เดียวกันยืนยันอีเมลพร้อมกันได้ |
| `/api/line/login/callback` · scope `line:login-callback` | ❌ | IP | **20 / ชม.** | แลก code กับ LINE ทุกครั้ง · คนปกติกดผูกบัญชีไม่กี่ครั้งต่อวัน |

## ทางเข้าที่ **จงใจไม่มี** เพดาน (และเหตุผล)

| ทางเข้า | ทำไมไม่ต้องมี |
|---|---|
| `/api/line/webhook/<gangId>` | ผ่าน **HMAC signature** ของก๊วนนั้นก่อนแตะอะไรทั้งสิ้น · ใส่เพดานต่อ IP เสี่ยง **ทิ้ง event จริงของ LINE** ตอนมีคนคุยกับ OA พร้อมกันเยอะ ⇒ ถ้าวันหนึ่งเจอ flood ของ signature ผิดจริง ค่อยเพิ่มเพดาน "เฉพาะกรณี verify ไม่ผ่าน" |
| `/api/cron/<job>` | ตรวจ `CRON_SECRET` แบบ timing-safe · fail-closed ถ้าไม่ตั้ง env |
| server action ที่ต้องล็อกอิน | มี `can()` + RLS + DB function เป็นด่านอยู่แล้ว และผูกกับบัญชีจริง (ไม่ใช่ทางเข้าสาธารณะ) |

## กติกาเวลาเพิ่มทางเข้าใหม่

1. เปิดให้คนไม่ล็อกอินเรียกได้เมื่อไหร่ → **ต้องมีเพดาน** และมาเติมในตารางนี้
2. ใช้ `enforceRateLimit()` / `withinRateLimit()` เท่านั้น — ห้ามนับเอง
3. 🔴 **fail-closed**: ตัวนับพัง = ปฏิเสธ ไม่ใช่ปล่อยผ่าน (เขียนไว้ในตัว helper แล้ว)
4. ❌ ห้าม log ค่า key เต็ม — ข้างในมี IP ของผู้ใช้
5. ตาราง `rate_limits` เป็น **unlogged** และถูกล้างด้วย cron `purge_rate_limits` (migration `0012`)
   ⇒ ไม่ต้องกังวลว่าจะโตไม่หยุด
