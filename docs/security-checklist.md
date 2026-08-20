# Security Checklist — ผลการเดินทีละข้อ

> baseline §Security Checklist: *"gate ก่อน deploy — อยู่ใน Phase 5"*
> เดินครบเมื่อ **20 ส.ค. 2026** ตอนปิด `WO-5.F` · ทุกข้อต้องมี **หลักฐานที่รันซ้ำได้** ไม่ใช่ติ๊กลอยๆ

| # | ข้อ | ผล | หลักฐาน |
|---|---|---|---|
| 1 | RLS เปิดทุกตาราง (มี test ยืนยัน) | ✅ | ตรวจของจริง: ไม่มีตารางใน `public` ที่ `relrowsecurity = false` · `tests/rls/grant-matrix.test.ts` (ตารางใหม่ที่ลืมประกาศสิทธิ์ = เทสต์แดง) · `tests/rls/tenant-isolation.test.ts` |
| 2 | Storage bucket ทุกตัวมี policy ตามตาราง Access | ✅ | 4 buckets · **16 policies** บน `storage.objects` (migration `0011`) · `tests/rls/tenant-isolation.test.ts` ยืนยันว่าคนนอกอ่านสลิปไม่ได้ |
| 3 | Secret อยู่ใน Vault หรือ env เท่านั้น — grep ยืนยันไม่มีใน code/DB | ✅ | `tests/security/rate-limit.test.ts` มี grep gate 4 ชั้น (JWT/service key ในโค้ด · `console.*` ที่ log secret · migration ที่เอา secret ใส่ `raise`/`event_logs`) · LINE credentials อยู่ใน **Vault** (`0035`/`0038`) ตารางเก็บแค่ secret id — `tests/line/credentials.test.ts` dump ทั้งแถวมาตรวจ |
| 4 | Secret token เก็บเป็น hash, ไม่ log plaintext token | ✅ | `session_invite_tokens.token_hash` · `session_registrations.guest_access_token_hash` (SHA-256 · migration `0003`) · รหัสผูกบัญชี LINE และ `state` ของ LINE Login เป็น HMAC **stateless** ไม่เก็บลง DB เลย |
| 5 | Security headers + CSP บน Next.js config | ✅ | `lib/security/csp.ts` + `proxy.ts` (nonce ต่อ request) + `next.config.ts` · `tests/security/csp.test.ts` (15) · **ยืนยันในเบราว์เซอร์จริง**: `e2e-browser/security.spec.ts` เดินทุกหน้าหลักแล้วไม่มี CSP violation |
| 6 | Rate limit บน endpoint ที่ guest/public เรียกได้ทุกตัว | ✅ | ตาราง + เหตุผลใน `docs/rate-limits.md` · `server/security/rate-limit.ts` เป็นตัวนับตัวเดียว (มีเทสต์ยืนยันว่าไม่มีไฟล์อื่นเรียก `check_rate_limit`) · `tests/security/rate-limit.test.ts` (17) |
| 7 | Cron/webhook routes ตรวจ `CRON_SECRET` / LINE signature ทุก request | ✅ | `server/cron/auth.ts` (timing-safe · fail-closed ถ้าไม่ตั้ง env) — `tests/cron/cron.test.ts` · `lib/line/signature.ts` verify จาก **raw body** — `tests/line/webhook.test.ts` (ลายเซ็นผิด/ไม่มี/body ถูกแก้ = 401 · secret ข้ามก๊วนไม่ผ่าน) |

## ของที่ยัง "รู้อยู่ว่ายังไม่ปิด" (ตัดสินใจแล้ว ไม่ใช่ลืม)

| เรื่อง | สถานะ | เหตุผล/เงื่อนไขที่ต้องกลับมาทบทวน |
|---|---|---|
| สมาชิกก๊วนเห็น `promptpay_id` ของก๊วนตัวเอง | ยอมรับ — **ADR-009** | เขาต้องใช้โอนเงินให้ก๊วนอยู่แล้ว · คนนอกถูกปิดแล้วโดย ADR-007 🔴 **ต้องกลับมาปิดถ้าวันหนึ่งเปิดให้คนนอกอ่าน `sessions`/`snapshot`** |
| หน้าแรก (static) ใช้ `script-src 'unsafe-inline'` | ยอมรับ — WO-5.B | Next ติด nonce ให้หน้า prerender ไม่ได้ · หน้าแรก **ไม่มีข้อมูลผู้ใช้เลย** ⇒ ไม่มีช่องให้ฉีดสคริปต์ · หน้าอื่นเข้มเต็มที่ (nonce + `strict-dynamic`) |
| `/api/line/webhook/<gangId>` ไม่มี rate limit | ยอมรับ — WO-5.C | ผ่าน HMAC ก่อนแตะอะไรทั้งสิ้น · เพดานต่อ IP เสี่ยงทิ้ง event จริงของ LINE 🔴 เพิ่มเพดาน "เฉพาะกรณี verify ไม่ผ่าน" ถ้าเจอ flood จริง |
| smoke ในเบราว์เซอร์ยังไม่ครอบหาง (ลงชื่อ → ปิดรอบ → ยอด) | ค้าง — `BACKLOG.md` | เส้นนั้นครอบแล้วใน `tests/e2e/mvp0-full-path.test.ts` (DB function + domain) ⇒ เป็นช่องว่างของ **การพิสูจน์ผ่าน UI** ไม่ใช่ช่องโหว่ของระบบ |
| `lib/supabase/client.ts` โยน error แล้วพังทั้งหน้าเมื่อ `NEXT_PUBLIC_*` ไม่ถูก inline | ค้าง — `BACKLOG.md` | ควร degrade เป็น polling (`lib/sync/fallback.ts` มีอยู่แล้ว) แทนพังทั้งหน้า · ตอนนี้กันด้วย runbook + env ใน CI |
| `event_logs` ยังเป็นระดับก๊วนสำหรับ event ที่ **ไม่ใช่** เรื่องเงิน | ยอมรับ — WO-5.D | สมาชิกควรเห็นไทม์ไลน์ของนัดตัวเอง · event เรื่องเงิน/`audit.*` ปิดที่ RLS แล้ว |

## วิธีเดินซ้ำ

```bash
npm run supabase -- start -x studio,logflare,vector,edge-runtime,mailpit
npm run supabase -- db reset
npm test                    # 712 — รวม RLS · concurrency · E2E ของทุก Phase

NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key จาก supabase status> \
npm run build
npm run test:e2e            # 8 — CSP/หน้าจอจริงในเบราว์เซอร์
```
