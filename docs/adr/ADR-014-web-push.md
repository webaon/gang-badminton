# ADR-014 — Web Push (ช่องแจ้งเตือนที่สามต่อจาก in-app และ LINE) (B15)

| | |
|---|---|
| **สถานะ** | 📝 **DRAFT** — รอเจ้าของงาน/planner ตัดสิน §8 (Q1–Q10) ก่อนเปิด WO เขียนโค้ด |
| **คำตัดสิน** | `docs/phase6-redesign-plan.md` §3.1 C6/C9 + §5 แถว B15 + §11.5 — กลับเข้าแผนเมื่อ 26 ต.ค. 2026 (baseline เดิมเขียนว่า "ไม่มี web push") |
| **วันที่ร่าง** | 28 ต.ค. 2026 |
| **ผู้ร่าง** | @gb-integrations (WO-B15-ADR · เอกสารเท่านั้น — **ไม่มีโค้ด/migration/CSP ถูกแก้ในใบนี้**) |
| **เกี่ยวข้อง** | WO-2.5-G (reminders) · WO-4.C (LINE fan-out + โควต้า) · WO-5.B (CSP) · WO-5.C (rate limit) · B11/ADR-011 (grace หลังถูกเลื่อนคิว) · ADR-013 (LINE Login) |
| **อ้างอิงโค้ดที่** | commit `407d53c` — `path:line` ตรวจจาก `git show HEAD:<path>` ที่ `aeb9fe1` แล้วยืนยันด้วย `git diff --stat aeb9fe1 HEAD` ว่าไฟล์ที่อ้างทั้งหมด (lib/security, proxy, server/cron, server/notifications, domain/notifications, migrations, .github, vercel.json, docs/rate-limits.md, tests/security/csp.test.ts ฯลฯ) **ไม่เปลี่ยน** ตั้งแต่นั้น |

> **วิธีอ่าน** — ทุกข้อที่ต้องให้คนตัดสินอยู่ใน **§8** ในรูป `แผนบอก X / ของจริงคือ Y / ทางเลือกคือ Z` โดย **★ = ที่แนะนำ** ·
> ข้อที่ **ยังพิสูจน์ไม่ได้จากเอกสาร/โค้ด** อยู่ใน **§9** (ต้อง spike) — ไม่ใช่ข้อเท็จจริง · ADR ต้องกลับมาทบทวนถ้า spike ล้ม

## สรุป 10 บรรทัด

1. **ช่องส่งที่มี:** `in_app` (แถวใน `notifications` คือข้อความเอง) + `line` (ต่อก๊วน, มีโควต้า) — คิวเดียว, claim ด้วย `claim_notifications()`, ส่งด้วย `dispatchNotifications()`; **Web push จะเป็นช่องที่สามในคิวเดิม ไม่มี worker ใหม่**
2. **คีย์:** `<dedupe_key เดิม>:push` ต่อจาก `:line` · fan-out ใน `enqueue_notifications()` เฉพาะคนที่มีอุปกรณ์สมัครไว้ + เปิดรับ
3. **ของที่ต้องสร้าง:** service worker (`public/sw.js`) · web app manifest · ตาราง `push_subscriptions` · เพิ่ม `'push'` ใน CHECK ของ `notifications`/`notification_logs` · `deliverPush()` ใน `server/cron/notifications.ts` · `domain/notifications/push-message.ts` (whitelist) · หน้า "ตั้งค่าการแจ้งเตือน"
4. **VAPID:** คู่กุญแจแพลตฟอร์มเดียว — public ใส่ `NEXT_PUBLIC_*` (browser ต้องใช้ตอน subscribe) · private + subject เป็น env ฝั่ง server (Vercel) **ไม่ใช่ Vault** (Vault ของเราเก็บ credential ต่อก๊วน)
5. **CSP:** ต้องเพิ่ม `worker-src 'self'` แน่นอน (ไม่พึ่ง fallback ไป `script-src` ที่มี `strict-dynamic`) + ต้องแก้ `proxy.ts` matcher ไม่ให้ `sw.js`/manifest ผ่านตัวรีเฟรช session
6. **iOS:** รับ push ได้ **เฉพาะเว็บที่ "เพิ่มลงหน้าจอโฮม" แล้ว** (iOS 16.4+) และขอสิทธิ์ต้องมาจากการแตะของผู้ใช้ ⇒ ต้องมี manifest + คำแนะนำในแอป
7. **ลบ subscription เมื่อ push service ตอบหมดอายุ (404/410)** + จำกัดจำนวนอุปกรณ์ต่อคน + เพดาน rate limit ที่ทางเข้าสมัคร/ถอน
8. 🔴 **ความเสี่ยงใหม่ที่หนักสุด = SSRF:** server จะ `POST` ไปยัง `endpoint` ที่ **client ส่งมาเอง** ⇒ ต้องตรวจโฮสต์ (allow-list) ก่อนบันทึกและก่อนส่ง
9. 🔴 **ข้อค้นพบจากโค้ด:** `waitlist.promoted`, `session.opened`, `payment.due` **ไม่ผ่าน `enqueue_notifications()`** (insert `in_app` ตรง) ⇒ ตอนนี้ **LINE ก็ไม่ได้รับ 3 เหตุการณ์นี้** ทั้งที่มีข้อความรอใน `line-message.ts` ⇒ push จะโดนปัญหาเดียวกันถ้าไม่แก้ (Q3)
10. **ความหน่วง:** ตัวส่งจริงรันทุก 5 นาทีจาก GitHub Actions — push ไม่ใช่ real-time (Q9)

---

## 1. Context — ของจริงในโค้ด

### 1.1 คิวและตัวส่งที่มีอยู่

| ข้อเท็จจริง | ที่มา |
|---|---|
| แผนเรียกว่า `notification_queue` แต่ **ตารางจริงชื่อ `notifications`** (ไม่มีตารางชื่อนั้น) — คอลัมน์: `channel`, `event_type`, `payload`, `status`, `attempt`, `next_retry_at`, `read_at`, `dedupe_key` | `supabase/migrations/20260810000005_platform.sql:73` |
| `channel` ถูก **CHECK เป็น `('in_app','line')`** ⇒ เพิ่ม `'push'` ต้องมี migration (drop/add constraint) — ทั้ง `notifications` และ `notification_logs` | `20260810000005_platform.sql:78`, `:132` |
| กระดิ่งกรอง `channel = 'in_app'` เท่านั้น ⇒ แถว `line`/`push` **ไม่โผล่ซ้ำในกระดิ่ง** (partial index ก็ตามนี้) | `app/notifications/page.tsx:24`, `20260810000005_platform.sql:116` |
| unique index กันซ้ำ `notifications_dedupe_key` (เฉพาะแถวที่ `dedupe_key` ไม่ null) | `20260814000029_reminder_dedupe.sql:27` |
| `enqueue_notifications(rows)` = **ทางเข้าเดียวที่ fan-out**: สร้าง `in_app` เสมอ (คีย์เดิม) + `line` (คีย์ `<เดิม>:line`) ให้เฉพาะก๊วนที่เปิด LINE + คนที่ผูกบัญชีและไม่บล็อก + ไม่เกินโควต้า · คืน "จำนวนแถวใหม่รวมทุก channel" | `20260816000037_line_fanout_quota.sql:169`, `:203-204` |
| ผู้เรียก `enqueue_notifications`: reminders (`session.reminder`, `payment.overdue`), `announcement.published`, `gang.join_requested`, `gang.join_decided` | `server/notifications/reminders.ts:58`, `20260815000032_announcement_publish.sql:77`, `20260815000033_discovery_join_requests.sql:222`, `:423` |
| worker: `claim_notifications()` (SKIP LOCKED) → `deliver()` สลับตาม channel → `mark_notification_sent()` | `server/cron/notifications.ts:98`, `:48-59` |
| `deliver()` รู้จักแค่ `in_app` (ไม่ต้องยิงอะไร) กับ `line`; channel อื่น ⇒ error "ไม่รู้จัก channel" | `server/cron/notifications.ts:49-58` |
| ส่งไม่สำเร็จ ⇒ backoff 5 นาที → 15 นาที → 1 ชม. เกิน 3 ครั้ง = `failed` ถาวร · ทุกครั้งเขียน `notification_logs` | `20260813000023_notifications.sql:141` (`when attempt >= 3`) |
| LINE ตรวจปลายทาง **ตอนส่งจริง** อีกรอบ (ผูกอยู่ไหม/บล็อก/ปิด/โควต้า) แล้วคืนข้อความบอกเหตุผล — ไม่ mark sent หลอก | `server/cron/notifications.ts:62-95` |
| โควต้า LINE นับจาก `notification_logs` เฉพาะ `channel='line'` และ `success` ⇒ push **ไม่กินโควต้า LINE** | `20260816000037_line_fanout_quota.sql:60` |
| RLS: ผู้ใช้ `select`/`update` ได้เฉพาะแถวของตัวเอง; insert เป็นงานของ DB function/worker | `20260811000010_rls.sql:552`, `:638` |
| ข้อความ LINE ผ่าน whitelist ต่อ event, ไม่มีตัวเลขเงินรายคน (เพราะหน้าจอล็อกคนข้างๆ เห็นได้) | `domain/notifications/line-message.ts:24-41` |
| ตัวส่งจริงขับโดย GitHub Actions **ทุก 5 นาที** (Vercel Hobby cron วันละครั้ง) · เตือนนัด/ยอดค้างรายชั่วโมง | `.github/workflows/cron.yml:11-12`, `vercel.json:10`, `docs/cron.md:14` |
| route handler cron ตรวจ `CRON_SECRET` แบบ timing-safe, fail-closed | `server/cron/auth.ts:3`, `app/api/cron/[job]/route.ts:44` |

### 1.2 🔴 สามเหตุการณ์ที่ "ข้าม" `enqueue_notifications()` (ข้อค้นพบ)

| เหตุการณ์ | วิธีเข้าคิวจริง | ที่มา | ผล |
|---|---|---|---|
| `waitlist.promoted` (**คิวถึงคุณแล้ว** — เร่งด่วนที่สุด) | `insert into notifications ... 'in_app'` ตรงในฟังก์ชัน promote (ไม่มี `dedupe_key`) | `20260811000009_db_functions.sql:546`; ฟังก์ชันใหม่ของ B11 ก็ทำเหมือนกัน `20260818000041_promoted_grace_admin_promote.sql:337` | **ไม่มี LINE และจะไม่มี push** |
| `session.opened` | `enqueue_session_notification()` insert `in_app` ตรง | `20260813000023_notifications.sql:85`; เรียกจาก `server/actions/sessions.ts:162` | เหมือนกัน |
| `payment.due` | `enqueue_session_notification()` | `server/actions/billing.ts:442` | เหมือนกัน |

มีข้อความ LINE เตรียมไว้แล้วสำหรับทั้งสาม (`line-message.ts:25-27,33`) แต่ **ไม่เคยถูกใช้จริง** เพราะไม่มีแถว `line` ถูกสร้าง — เป็นช่องว่างที่มีอยู่ก่อน ADR นี้ · ส่วน `session.charges_committed`/`membership.fees_generated` ที่เห็นใน grep เป็น **`event_logs`** (audit) ไม่ใช่ notification (`20260813000025_membership_billing.sql:99-102`, `20260817000039_tighten_read_policies.sql:47`)

### 1.3 ฝั่งเบราว์เซอร์ — ยังไม่มี PWA เลย

| ข้อเท็จจริง | ที่มา |
|---|---|
| ไม่มี `manifest`, ไม่มี service worker, ไม่มี icon ในแอป — `public/` มีแค่ SVG ตัวอย่างของ create-next-app (`file/globe/next/vercel/window.svg`) | `ls public`; grep `serviceWorker\|manifest` ในโค้ดแอป = 0 (มีแต่ "prerender-manifest" ในเทสต์ CSP) |
| `metadata` ของ layout มีแค่ `title`/`description`; `viewport` มีแค่ width/scale | `app/layout.tsx:8-16` |
| CSP: **ไม่มี `worker-src`/`child-src`** — มี `default-src 'self'` และ `script-src` ที่หน้า dynamic = `'self' 'nonce-…' 'strict-dynamic'`, หน้า static = `'self' 'unsafe-inline'` | `lib/security/csp.ts:90-101` |
| `connect-src` = `'self'` + Supabase เท่านั้น | `lib/security/csp.ts:107` |
| `Permissions-Policy` ปิด camera/microphone/geolocation/payment — **ไม่ได้พูดถึง notifications/push** (ไม่ถูกบล็อก) | `lib/security/csp.ts:138` |
| `proxy.ts` ครอบทุก path ยกเว้น `_next/static`, `_next/image`, `favicon.ico` และไฟล์ `.svg/.png/.jpg/.jpeg/.gif/.webp` ⇒ `sw.js` และ `*.webmanifest` **ผ่าน proxy** (รีเฟรช session + ติด CSP ของหน้า) | `proxy.ts:46-50` |
| เทสต์ `STATIC_ROUTES` อ่าน `.next/prerender-manifest.json` แล้วเทียบ — กรองเฉพาะ `.ico/.png/.svg/.jpg/.jpeg/.webp/.txt/.xml` ⇒ **route ใหม่ที่ prerender (เช่น `app/manifest.ts` → `/manifest.webmanifest`) อาจทำให้เทสต์นี้ล้ม** | `tests/security/csp.test.ts:70-90` |
| มี `OfflineBanner` อยู่แล้ว (แถบ "ไม่มีอินเทอร์เน็ต") — ไม่เกี่ยวกับ SW แต่เป็นตัวบอกว่า UX ออฟไลน์เริ่มถูกคิดไว้ | `components/layout/OfflineBanner.tsx:29` |
| Node `>=22` (มี `node:crypto` ครบสำหรับ ECDSA P-256 / AES-GCM ที่ Web Push ต้องใช้) | `package.json` `engines` |
| **ยังไม่มี** dependency `web-push` (grep package.json = ไม่พบ) | `package.json` |

---

## 2. Decision (ร่าง — รอ §8)

### D1. ช่อง `push` ในคิวเดิม — ไม่มี worker ใหม่
- เพิ่ม `'push'` ใน CHECK ของ `notifications.channel` และ `notification_logs.channel` (migration แบบ drop/add constraint — additive, ไม่แตะข้อมูลเดิม)
- `enqueue_notifications()` เพิ่ม target ที่สามต่อจาก `in_app` และ `line`:
  - คีย์ = `<dedupe_key เดิม> || ':push'` (null → null เหมือน `:line` ที่ `20260816000037:204`)
  - เงื่อนไข: ผู้รับมี `push_subscriptions` ≥ 1 แถว **และ** เปิดรับ event ชนิดนั้น (D8)
  - **ไม่ผูกกับ `gang_line_configs`** — push เป็นของแพลตฟอร์ม ใช้ได้แม้ก๊วนไม่มี LINE ("ก๊วนที่ไม่มี LINE ต้องใช้งานเว็บได้เต็ม" ยังเป็นจริง)
- `deliver()` เพิ่ม `case 'push': return deliverPush(notification)`
- ❌ ห้ามสร้าง worker/cron ใหม่ — ใช้ `claim_notifications()` + `dispatchNotifications()` + backoff เดิมทุกอย่าง
- ⚠️ `enqueue_notifications()` คืน "จำนวนแถวรวมทุก channel" (`20260816000037_line_fanout_quota.sql:167`) — เทสต์ที่เทียบจำนวนกับผู้รับต้องรู้ว่า push ทำให้ตัวเลขเพิ่มเฉพาะคนที่มีอุปกรณ์ (เทสต์เดิมไม่มี subscription ⇒ ไม่กระทบ)

### D2. ตาราง `push_subscriptions` (ระดับ **อุปกรณ์ของผู้ใช้** ไม่ใช่ต่อก๊วน)

| คอลัมน์ | หมายเหตุ |
|---|---|
| `id uuid` (uuidv7), `user_id → profiles ON DELETE CASCADE` | ลบบัญชี ⇒ ลบ subscription |
| `endpoint text` **UNIQUE**, `p256dh text`, `auth text` | จาก `PushSubscription.toJSON()` — `auth`/`p256dh` เป็นความลับระดับการเข้ารหัสข้อความ ⇒ **ห้ามส่งกลับ client** |
| `device_label text` (≤ 80) | ป้ายหยาบๆ ("Chrome · Android") สร้างฝั่ง server จาก UA — ไม่เก็บ UA ดิบ |
| `created_at`, `last_success_at`, `last_error_at`, `fail_count int` | ใช้เก็บกวาด/วินิจฉัย |

- **RLS/GRANT:** เปิด RLS · `authenticated` ได้แค่ `select (id, device_label, created_at, last_success_at)` ผ่าน **column-level GRANT** และ `delete` ของตัวเอง · **ไม่มี** `insert`/`update` สำหรับ client — การสมัครไปผ่าน server action → DB function (`security definer`, `service_role`-only execute) ที่ตรวจ endpoint (D6) และเพดานจำนวนอุปกรณ์ต่อคน (★ 10)
- 🔴 ตารางนี้ไม่มี `gang_id` — เป็นข้อยกเว้นจากหลัก "tenant key นำหน้าทุก index" เพราะอุปกรณ์เป็นของคน ไม่ใช่ของก๊วน · ความเป็นเจ้าของ = `user_id` + RLS `user_id = auth.uid()`

### D3. Service worker + manifest
- `public/sw.js` (ไฟล์ static ไม่ผ่าน bundler) — ทำ **แค่สามอย่าง**: `push` (แสดง notification จาก payload ที่ผ่าน whitelist), `notificationclick` (เปิด/โฟกัสหน้าตาม `url` ใน payload), `pushsubscriptionchange` (ถ้ารองรับ — สมัครใหม่และแจ้ง server)
- ❌ **ไม่ทำ offline cache / precache / fetch handler** ใน v1 — SW ที่ดักทุก fetch คือความเสี่ยงสำหรับแอปที่เป็นเงิน (หน้าจ่ายเงินค้างเก่า)
- 🔴 `url` ใน payload เป็น **path ภายในแอปที่ server สร้างเอง** (`/gangs/<id>/...`) ไม่รับจาก client · SW ต้องตรวจว่าเป็น path ขึ้นต้น `/` ไม่ใช่ URL เต็ม ก่อน `openWindow`
- manifest: `name`/`short_name` = "Gang Badminton" (คำตัดสิน C2: ชื่อในแอปยังไม่เปลี่ยน), `start_url: '/'`, `display: 'standalone'`, icon 192/512 (**ต้องมีไฟล์ภาพจริง — ตอนนี้ไม่มี**) · Next รองรับ `app/manifest.ts` หรือไฟล์ static (Next.js PWA guide — §10)
- ★ ใช้ไฟล์ static `public/manifest.webmanifest` แทน `app/manifest.ts` เพื่อเลี่ยงการเข้า `prerender-manifest.json` (ดู S5)

### D4. VAPID — เก็บที่ไหน

| ค่า | ที่เก็บ | เหตุผล |
|---|---|---|
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | env สาธารณะ (browser ต้องใช้เป็น `applicationServerKey` ตอน `subscribe`) | ไม่ลับ · ต้องอ้างแบบสตริงเต็มตามกติกาเดิม `lib/supabase/env.ts:7` |
| `VAPID_PRIVATE_KEY` | env ฝั่ง server บน **Vercel** (เช่น `CRON_SECRET` — `.env.example:34`) | เซ็น JWT ตอนส่ง · **ไม่ใช่ Vault** — Vault ของเราเก็บ credential *ต่อก๊วน* (`line_delivery_context` อ่านผ่าน service_role) นี่เป็นความลับระดับแพลตฟอร์มเดียว |
| `VAPID_SUBJECT` | env ฝั่ง server | RFC 8292 §2.1: `sub` ควรเป็น `mailto:` หรือ `https:` URI (Q10) |

- สร้างคู่กุญแจครั้งเดียว (`web-push generate-vapid-keys`) — ❌ ห้ามเอา private key ลง repo/`.env.example`/แชต/log · เจ้าของงานกรอกเองใน Vercel (กติกาเดิมเรื่อง secret)
- ⚠️ **เปลี่ยน VAPID key = subscription เดิมทุกอันใช้ไม่ได้** (subscription ผูกกับ `applicationServerKey` ตอนสมัคร — ต้องยืนยันใน S4) ⇒ ถือเป็นการเปลี่ยนที่ทำลาย, ไม่ใช่การ rotate ปกติ
- fail-closed: ไม่ตั้ง env ครบ ⇒ `deliverPush` คืน error "ยังไม่ได้ตั้ง VAPID" และ UI ซ่อนปุ่มเปิดแจ้งเตือน (เหมือน `LINE_PLATFORM_LOGIN_ENABLED`) · ★ ซ่อนหลัง flag `WEB_PUSH_ENABLED=true` ตอนแรก

### D5. การส่ง (`deliverPush`) — พฤติกรรม

1. โหลด subscription ของ `recipient_id` (service_role) · ไม่มีเลย ⇒ คืน error "ไม่มีอุปกรณ์รับ push" (เข้า backoff/failed เหมือน LINE ที่ผูกไม่ได้)
2. ประกอบ payload จาก **`domain/notifications/push-message.ts`** (ใหม่ — whitelist ต่อ event แบบเดียวกับ `line-message.ts`): `{title, body, url, tag}` เท่านั้น
   - 🔴 ไม่มีตัวเลขเงินรายคน, ไม่มีชื่อบุคคลอื่น (หน้าจอล็อกเห็นได้) — กติกาเดียวกับ `line-message.ts:7-8`
   - event ที่ไม่รู้จัก ⇒ ข้อความกลางๆ "มีการอัปเดตใหม่ — เปิดแอปเพื่อดู" (ไม่ทิ้ง, ไม่หลุด payload ดิบ)
   - ขนาด payload เล็ก (< 1 KB) — เนื้อหาเต็มอยู่ในแอป
3. ส่งผ่านไลบรารี Web Push (Q8) พร้อม header: `TTL` ตาม event, `Urgency`, `Topic` = `tag` (RFC 8030 §5.2–5.4 — Topic ทำให้ข้อความใหม่แทนข้อความเก่าที่ยังไม่ส่งถึง ⇒ ไม่กองซ้ำเมื่อเครื่องออฟไลน์)
   - ★ TTL: `waitlist.promoted` = ถึงหมด grace (ค่าเริ่ม 3 ชม. — ADR-011) · `session.reminder` = ถึงเวลาเริ่มนัด · อื่นๆ = 24 ชม.
4. ผลต่ออุปกรณ์แต่ละเครื่อง:
   - สำเร็จ (2xx) ⇒ `last_success_at = now()`, `fail_count = 0`
   - **404/410** ⇒ **ลบ subscription นั้น** (push service บอกว่าหมดอายุ/ถูกยกเลิก — พฤติกรรมมาตรฐาน, ดู S3)
   - 429/5xx/timeout ⇒ `fail_count += 1`, `last_error_at` · `fail_count` เกินเกณฑ์ (★ 10 รอบติด) ⇒ ลบ
   - 400/403 ⇒ log สถานะ (ไม่ log endpoint/key เต็ม) — ปกติคือ VAPID ผิด/payload ผิด ไม่ใช่ความผิดของอุปกรณ์
5. **ผลรวมของ notification แถวเดียว:** สำเร็จถ้า **อย่างน้อย 1 อุปกรณ์รับ** (★) — กันการ retry ทั้งแถวแล้วอุปกรณ์ที่ได้ไปแล้วเด้งซ้ำ · ทุกอุปกรณ์ล้ม ⇒ คืน error เข้า backoff เดิม
6. ส่งแบบ concurrency จำกัด (★ 5) ต่อ batch — `dispatchNotifications` ปัจจุบันหยิบ 25 แถวต่อรอบ (`server/cron/notifications.ts:100`) และวนทีละแถว · 1 แถวอาจมีหลายอุปกรณ์ ⇒ ต้องมี timeout ต่อ request (ไม่ปล่อยให้ push service ช้าลาก function จนหมดเวลา)

### D6. 🔴 ความปลอดภัยของ `endpoint` (SSRF)
- `endpoint` มาจาก client แล้ว **server เป็นคน `POST` ไป** ⇒ ถ้าไม่ตรวจ ผู้ใช้ที่ล็อกอินส่ง `http://169.254.169.254/...` หรือโฮสต์ภายในแล้วให้ worker ยิงแทนได้
- กติกา (ตรวจ **สองจุด**: ตอนสมัคร และตอนส่งทุกครั้ง — กันข้อมูลเก่าที่หลุดเข้าตาราง):
  1. ต้องเป็น `https:` เท่านั้น, ไม่มี userinfo, ไม่มี port แปลก, ความยาวจำกัด (★ ≤ 2048)
  2. โฮสต์ต้องอยู่ใน **allow-list ของ push service ที่เป็นที่รู้จัก** (★) — ตัวอย่างที่คาดว่าจะเจอ: `fcm.googleapis.com` (Chrome/Edge/Android), `*.push.services.mozilla.com` (Firefox), `*.push.apple.com` (Safari/iOS), `*.notify.windows.com` (Edge/Windows เดิม) — **รายชื่อนี้มาจากความรู้ ไม่ได้พิสูจน์จากเอกสารในรอบนี้ ⇒ S3 ต้องจับ endpoint จริงจากอุปกรณ์จริงก่อนล็อกรายการ**
  3. (ทางเลือกถ้า allow-list ตกหล่นจริง — Q7) https + บล็อก IP ส่วนตัว/loopback/link-local หลัง DNS resolve
- ❌ ห้าม follow redirect ตอนส่ง · ห้าม log endpoint เต็ม (มีโทเคนฝังในพาธ) — log เฉพาะโฮสต์ + สถานะ

### D7. CSP และ proxy (ห้ามแก้ในใบนี้ — ระบุเพื่อ WO ถัดไป)
- เพิ่ม `['worker-src', "'self'"]` ใน `buildContentSecurityPolicy` (`lib/security/csp.ts` ใกล้ `:101`)
  - เหตุผล: worker-src ถ้าไม่ตั้งจะ fallback ไป `child-src` → `script-src` → `default-src` (พฤติกรรมตามสเปก CSP) แต่ `script-src` ของหน้า dynamic ใช้ `strict-dynamic` ซึ่งตามสเปกทำให้ `'self'` ไม่ถูกนับ ⇒ **ไม่ควรพึ่ง fallback** — ตั้ง `worker-src 'self'` ตรงๆ แล้วพิสูจน์ด้วย Playwright (S1)
  - ไม่ต้องเพิ่มโฮสต์ push service ใน `connect-src`: การยิง push เกิดจาก **server** ไปหา push service และเบราว์เซอร์รับผ่านช่องทางของมันเอง ไม่ใช่ `fetch` จากหน้าเรา (S2 ยืนยัน)
- เพิ่มเทสต์ใน `tests/security/csp.test.ts` (มีเทสต์รายตัว directive อยู่แล้ว เช่น `:133`) ว่ามี `worker-src 'self'` และไม่มี `*`/`blob:`/`data:`
- `proxy.ts` `matcher` (`:46-50`): เพิ่ม `sw.js`, `*.webmanifest` และไฟล์ icon ที่เป็น static ให้ **ไม่ผ่าน proxy** — ไม่มีเหตุให้รีเฟรช session/ติด nonce-CSP ให้สคริปต์ SW (และเบราว์เซอร์ตรวจ `sw.js` ใหม่เป็นระยะ ⇒ ไม่ควรกระตุ้น Supabase ทุกครั้ง)
- `next.config.ts` `headers()`: `/sw.js` ควรได้ `Cache-Control: no-cache` (ให้ SW อัปเดตทันที) · `X-Content-Type-Options: nosniff` ที่ตั้งทั้งไซต์ (`lib/security/csp.ts:132` ในชุด `staticSecurityHeaders` `:128`) บังคับให้ `sw.js` ต้องเสิร์ฟเป็น JavaScript MIME — ไฟล์ใน `public/` ปกติถูกต้องอยู่แล้ว (ยืนยันใน S1)
- ⚠️ ถ้าใช้ `app/manifest.ts` และ Next prerender เป็น static ⇒ เทสต์ `STATIC_ROUTES` (`tests/security/csp.test.ts:70-90`) อาจล้มเพราะ `/manifest.webmanifest` ไม่อยู่ในตัวกรอง — ไฟล์ static ใน `public/` หลีกเลี่ยงได้ (D3)

### D8. Opt-in / opt-out
- **ไม่ขอสิทธิ์ตอนเข้าเว็บ** — ขอเฉพาะเมื่อผู้ใช้กดปุ่ม "เปิดการแจ้งเตือนบนอุปกรณ์นี้" (iOS บังคับให้มาจาก user gesture — WebKit blog; เบราว์เซอร์อื่นก็ถือเป็น practice ที่ดี)
- ระดับการควบคุม (Q5): **(ก) ต่ออุปกรณ์** — ปุ่มเปิด/ปิดของเครื่องนั้น (= สมัคร/ลบ `push_subscriptions` แถวนั้น) **(ข) ต่อชนิดเหตุการณ์** — toggle รายประเภท (C9: "permission + toggle รายประเภท") เก็บเป็นตารางเล็ก `notification_preferences(user_id, push jsonb)` หรือคอลัมน์ใน `profiles` (Q5)
- ปิดสิทธิ์ที่ตัวเบราว์เซอร์/ตั้งค่า OS ได้เสมอ — แอปต้องตรวจ `Notification.permission` ตอนเปิดหน้าตั้งค่าแล้วบอกสถานะจริง ("ถูกบล็อกในเบราว์เซอร์ — เปิดที่ตั้งค่าเครื่อง") ไม่ใช่โชว์สวิตช์ที่เปิดอยู่ทั้งที่ส่งไม่ถึง
- ออกจากระบบ (`signOut`) ไม่ควรลบ subscription อัตโนมัติ (ผู้ใช้ยังอยากรับ) แต่ **เครื่องที่ผู้ใช้อื่นล็อกอินต่อ** ⇒ สมัครซ้ำด้วย endpoint เดิมต้อง **ย้ายความเป็นเจ้าของ** (endpoint UNIQUE → upsert ตาม endpoint ให้ `user_id` ใหม่) ไม่งั้นข้อความของผู้ใช้เก่าไปเด้งบนเครื่องที่ผู้ใช้ใหม่ถืออยู่ (ดู T4)
- ❌ ห้าม push ที่ผู้ใช้ปิดชนิดนั้นไว้ — เช็คตอน fan-out **และ** ตอนส่ง (เหมือน LINE ที่เช็คสองจุด)

### D9. Rate limit / quota
ทางเข้าใหม่ (ทุกอันเป็น server action ที่ต้องล็อกอิน — ต้องเพิ่มแถวใน `docs/rate-limits.md` และ `tests/security/rate-limit.test.ts` ตามกติกา `docs/rate-limits.md:35`):

| ทางเข้า | scope เสนอ | key | เพดาน ★ |
|---|---|---|---|
| `subscribePush(subscription)` | `push:subscribe` | ผู้ใช้ + IP | 10 / ชม. (ผูกครั้งเดียวต่ออุปกรณ์; เพดานต่อชั่วโมงกันสคริปต์ยัด endpoint) |
| `unsubscribePush(id)` | `push:unsubscribe` | ผู้ใช้ + IP | 20 / ชม. |
| `updatePushPreferences(...)` | `push:prefs` | ผู้ใช้ | 30 / ชม. |
| (เพดานข้อมูล) จำนวนอุปกรณ์ต่อผู้ใช้ | — | ผู้ใช้ | ≤ 10 แถว (ตรวจใน DB function; เกิน ⇒ `VALIDATION_ERROR`) |

- push **ไม่มีโควต้าเงินแบบ LINE** (ไม่เสียต่อข้อความ) — แต่ต้องกัน **ปริมาณ**: `announcement.published` ส่งให้ทุกสมาชิกก๊วน; ผู้ดูแลที่ถูกยึดบัญชีจึงยิง push ถึงทั้งก๊วนได้ ⇒ ใช้ dedupe เดิม (ต่อประกาศ+ผู้รับ) และเพดาน publish ที่มีอยู่ (ถ้ามี — ยังไม่ได้ตรวจในรอบนี้, ใส่ใน S6)
- ❌ ไม่มี endpoint สาธารณะใหม่ (ไม่มี API route ที่ไม่ล็อกอิน) ⇒ ไม่เพิ่มรายการใน "ทางเข้าสาธารณะ"

### D10. iOS / PWA
- iOS/iPadOS 16.4+: Web Push ใช้ได้ **เฉพาะเว็บที่ถูกเพิ่มลงหน้าจอโฮม (Home Screen web app)** ซึ่งต้องมี manifest ที่ `display` เป็น `standalone`/`fullscreen`; ขอสิทธิ์ต้องมาจากการแตะของผู้ใช้; ผู้ใช้จัดการสิทธิ์ต่อแอปใน Settings → Notifications (WebKit blog 16 ก.พ. 2023) · Next.js PWA guide ระบุตรงกัน (iOS 16.4+ สำหรับแอปที่ติดตั้งลงหน้าจอ, Safari 16 บน macOS 13+, Chromium, Firefox)
- ⇒ ผู้ใช้ iPhone ที่เปิดผ่านเบราว์เซอร์ทั่วไป **ไม่มีทางรับ push ได้** จนกว่าจะ "เพิ่มลงหน้าจอโฮม" · LINE เป็นช่องทางสำรองที่ผู้ใช้ไทยส่วนใหญ่ใช้อยู่แล้ว ⇒ push ไม่ใช่ช่องทางเดียว และ **in-app + LINE ต้องไม่ถูกลดบทบาท**
- UI: หน้า "ตั้งค่าการแจ้งเตือน" ตรวจสภาพแวดล้อม (`'serviceWorker' in navigator`, `'PushManager' in window`, `display-mode: standalone`) แล้วแสดงคำแนะนำตามกรณี: รองรับ→ปุ่มเปิด · iOS ยังไม่ติดตั้ง→วิธี "แชร์ → เพิ่มลงหน้าจอโฮม" (ภาพ/ข้อความ) · ไม่รองรับ→บอกว่าใช้ LINE/ในแอปแทน
- 🔴 ภายใน LINE in-app browser/LIFF ยังไม่ทราบว่าสมัคร push ได้ไหม (WebView) ⇒ ตรวจ `PushManager` ก่อนแสดงปุ่ม และ spike S7 — **อย่าสัญญาในข้อความว่าเปิดจากลิงก์ LINE แล้วจะได้ push**

### D11. สิ่งที่ไม่ทำใน v1 (ลง `BACKLOG.md` ตอนเปิด WO)
- offline cache / background sync / SW fetch handler · badge count · action buttons บน notification · push ที่ไม่ขึ้น notification (silent push — iOS ไม่อนุญาตและอาจถูกเพิกถอนสิทธิ์) · mute ต่อก๊วน · digest รวมหลายเหตุการณ์ · สถิติ open-rate

---

## 3. ภัยคุกคามและกฎที่ปิด (ต้องมีเทสต์ทุกข้อ)

| # | ภัย | กฎที่ปิด |
|---|---|---|
| T1 | **SSRF ผ่าน `endpoint`** — client กำหนด URL ที่ server จะ `POST` | D6: https + allow-list โฮสต์ ตรวจทั้งตอนสมัครและตอนส่ง · ไม่ follow redirect · log เฉพาะโฮสต์ |
| T2 | **ข้อมูลรั่วบนหน้าจอล็อก** — คนข้างๆ เห็น notification | D5: whitelist `push-message.ts` · ไม่มียอดเงินรายคน/ชื่อคนอื่น · ไม่ส่ง payload ดิบ |
| T3 | **XSS → SW/สมัคร subscription ของผู้โจมตี** | `worker-src 'self'` (ไม่ใช่ `*`/`blob:`) · `sw.js` อยู่ใน `public/` ของเรา · action สมัครต้องล็อกอิน + rate limit · ✅ CSP ยังบังคับ nonce+`strict-dynamic` ที่หน้าอื่น (`csp.ts:90`) |
| T4 | **เครื่องร่วม/ส่งต่อ** — ผู้ใช้ A ออกจากระบบ ผู้ใช้ B ล็อกอินเครื่องเดิม ข้อความของ A ยังเด้ง | endpoint UNIQUE + upsert ย้ายเจ้าของเมื่อ B กดเปิดแจ้งเตือนบนเครื่องเดียวกัน · UI แนะนำให้ปิดการแจ้งเตือนบนอุปกรณ์นี้ก่อนออกจากระบบ · ⚠️ ถ้า A ไม่เคยกดปิดและ B ไม่เคยเปิด ข้อความของ A ยังไปเครื่องนี้ — ข้อจำกัดที่ต้องยอมรับ/อธิบาย (ยืนยันพฤติกรรมจริงใน S8) |
| T5 | **VAPID private key รั่ว** — ใครมี key ส่ง push ปลอมในนามเราไปทุกอุปกรณ์ได้ | env ฝั่ง server เท่านั้น · ไม่ log · เทสต์ grep ห้ามสตริง `VAPID_PRIVATE_KEY` ในโค้ด client/`NEXT_PUBLIC_` · การเปลี่ยน key = ผู้ใช้ต้องสมัครใหม่ทั้งหมด (D4) |
| T6 | **ยัด subscription ปริมาณมาก** (ใช้ตารางเป็นที่ฝากข้อมูล / ทำให้ worker ช้า) | เพดาน 10 แถว/ผู้ใช้ + rate limit D9 + ความยาว endpoint/keys จำกัด |
| T7 | **ส่งซ้ำ/พายุ push** — retry ทั้งแถวทำให้เด้งซ้ำ | D5: สำเร็จเมื่อ ≥ 1 อุปกรณ์ · `Topic` แทนข้อความเก่า · dedupe_key `:push` + unique index เดิม |
| T8 | **IDOR ถอด subscription ของคนอื่น** | `unsubscribePush(id)` ตรวจ `user_id = session user` ใน DB function · RLS `delete` เฉพาะแถวตัวเอง · ❌ ไม่รับ `user_id` จาก client |
| T9 | **Log รั่ว** — endpoint มีโทเคนฝัง, `auth`/`p256dh` | ห้าม log ค่าเหล่านี้ทุกที่ (รวม error ของไลบรารีที่อาจแนบ subscription) · เทสต์ spy `console.*` |

---

## 4. Consequences

**ดี**
- ผู้เล่นได้ข้อความ "คิวถึงคุณแล้ว" แม้ไม่ผูก LINE และไม่ได้เปิดแอป · ก๊วนที่ไม่มี LINE OA ได้ช่องทางภายนอกแอปเป็นครั้งแรก
- ไม่กิน/ไม่ต้องพึ่งโควต้า LINE (`line_quota_status` นับเฉพาะ `channel='line'` — `20260816000037:60`)
- ใช้คิว/backoff/dedupe/sweep เดิมทั้งหมด — พื้นที่ใหม่มีแค่ตาราง subscription + `deliverPush`

**เสีย / ต้องยอมรับ**
- **งานแตะหลายชั้น:** migration (CHECK + ตาราง + `enqueue_notifications`) · server · SW/manifest/icon · CSP/proxy/next.config · UI · docs — ควรแบ่ง WO (§6)
- **เพิ่ม dependency** (`web-push` — Q8) ⇒ ต้อง `npm install` ซึ่งตามกติกาทีมต้องผ่าน planner อนุมัติก่อน
- **ความหน่วง 5+ นาที** (GitHub Actions `*/5` + jitter — `cron.yml:11`) — push ไม่ใช่ real-time · `waitlist.promoted` มี grace 3 ชม. (ADR-011) จึงรับได้ แต่ถ้าต้องการทันที ต้องเรียก dispatch ต่อท้ายการเข้าคิว (รูปแบบเดียวกับ `server/actions/line.ts:380`) ซึ่งเพิ่มเวลา request (Q9)
- **iOS ต้องติดตั้งลงหน้าจอโฮม** — เปอร์เซ็นต์ผู้ใช้ที่ทำจริงเป็นสิ่งที่วัดได้หลังเปิดใช้เท่านั้น
- **ข้อความสามชั้นต่อเหตุการณ์เดียว** (in-app + LINE + push) ถ้าไม่ตัดสินใจเรื่องซ้ำซ้อน (Q2)
- เปลี่ยน CSP = พื้นผิวความปลอดภัยเปลี่ยน ⇒ ต้องมีเทสต์เพิ่มและ Playwright เดินปุ่มจริง

**ห้าม (Forbidden ของ WO ที่ตามมา)**
- ❌ worker/cron ใหม่ · ❌ ตารางคิวใหม่ · ❌ ส่ง payload ดิบ/ยอดเงินรายคนใน push · ❌ รับ URL ปลายทางของ `notificationclick` จาก client · ❌ SW ที่ดัก `fetch`/cache หน้าแอป · ❌ เก็บ VAPID private key ใน repo/Vault ต่อก๊วน/แชต · ❌ `connect-src`/`worker-src` แบบ `*` · ❌ ขอสิทธิ์ notification ตอนโหลดหน้า (ต้องมาจากปุ่ม)

---

## 5. Test plan

**Unit / DB (vitest, local Supabase — ห้าม db reset)**
1. `enqueue_notifications`: คนมี subscription + เปิดรับ ⇒ ได้แถว `push` คีย์ `<key>:push` · ไม่มี subscription ⇒ ไม่มีแถว `push` · ปิดชนิดนั้น ⇒ ไม่มี · `dedupe_key` null ⇒ push ก็ null (ไม่ error) · รันซ้ำไม่เกิดแถวซ้ำ (unique index เดิม) · แถว `in_app` และ `line` ไม่เปลี่ยนพฤติกรรม (regression)
2. กระดิ่ง `/notifications` ไม่มีแถว `push` (กรอง `channel='in_app'`) — เทสต์ว่าแถว push ไม่โผล่
3. ตาราง `push_subscriptions`: RLS — `select` เห็นเฉพาะแถวตัวเองและ **ไม่มีคอลัมน์ `auth`/`p256dh`/`endpoint`** (column GRANT) · `delete` ของคนอื่นไม่ได้ · `insert`/`update` ตรงจาก client ถูกปฏิเสธ · เพดาน 10 แถวต่อคน · endpoint ซ้ำ ⇒ ย้ายเจ้าของ (T4)
4. `validatePushEndpoint` (pure): `http:`, `localhost`, IP ตรง, `169.254.*`, userinfo, port แปลก, host นอก allow-list, ยาวเกิน ⇒ ปฏิเสธ · host ใน allow-list ผ่าน · ตรวจซ้ำตอนส่ง
5. `deliverPush` (ไลบรารี mock): สำเร็จ ≥ 1 เครื่อง ⇒ sent · ทุกเครื่องล้ม ⇒ error เข้า backoff · 404/410 ⇒ ลบเฉพาะ subscription นั้นและเครื่องอื่นยังได้ · ไม่มี subscription ⇒ error ข้อความชัด · env VAPID ไม่ครบ ⇒ fail-closed · `fail_count` เกินเกณฑ์ ⇒ ลบ · header `TTL`/`Topic`/`Urgency` ตรงตาม event
6. `push-message.ts`: ทุก `event_type` ที่มีใน `NotificationList` (`features/notifications/NotificationList.tsx` EVENT_LABELS) มีข้อความเฉพาะ · ไม่มีตัวเลข/ชื่อบุคคลใน body (เทสต์ regex) · event ไม่รู้จัก ⇒ ข้อความกลางๆ · `url` เป็น path ภายในเท่านั้น
7. grep-gate: ไม่มี `VAPID_PRIVATE_KEY` นอก `server/`; client component ไม่ import ไฟล์ `server-only` (บทเรียน B1.c: `next build` จับ แต่ `tsc` ไม่จับ)
8. rate limit: ครบ scope ใน `docs/rate-limits.md` + แถวใน `tests/security/rate-limit.test.ts`; ครั้งที่ 11 ของ `push:subscribe` ถูกตัดจริงใน Postgres
9. worker เดิม: `claim_notifications` + `mark_notification_sent` ทำงานกับ channel `push` โดยไม่แก้ฟังก์ชัน (เหมือนเทสต์ `WO-2.5-G — ใช้คิวเดิม`)

**CSP / build**
10. `tests/security/csp.test.ts`: มี `worker-src 'self'` · ไม่มี wildcard · เทสต์ `STATIC_ROUTES` ยังผ่านหลังเพิ่ม manifest/icon · `proxy.ts` matcher ไม่ครอบ `sw.js`
11. `npm run build` ผ่าน (บทเรียน: ต้องรันหลัง mount component ใหม่ทุกครั้ง)

**Playwright (browser จริง — Chromium)**
12. หน้าตั้งค่า: ปุ่มเปิด ⇒ ขอสิทธิ์ (ใช้ `context.grantPermissions(['notifications'])`) ⇒ SW ลงทะเบียน (`navigator.serviceWorker.ready`) ⇒ **ไม่มี CSP violation ใน console** · สถานะ `Notification.permission='denied'` ⇒ UI บอกถูกต้อง
13. ส่ง push จริงจาก server ในโหมดทดสอบ (ไลบรารีชี้ไป mock push service ในเครื่อง) ⇒ SW แสดง notification ⇒ `notificationclick` เปิด path ที่ถูก · ❗ push service จริงของ Chrome/Safari ทดสอบอัตโนมัติไม่ได้ ⇒ มี **checklist ทดสอบมือบนอุปกรณ์จริง** (Android Chrome, iPhone ที่ติดตั้งลงหน้าจอโฮม, desktop Chrome) เป็นส่วนของ DoD
14. มือถือ 390px: คำแนะนำ iOS แสดงถูกเมื่อไม่ใช่ standalone

---

## 6. WO ที่ตามมา (เสนอ — ยังไม่เปิด)

| WO | เจ้าของ | งาน | พึ่ง |
|---|---|---|---|
| **B15.0 spike** | @gb-integrations (+เจ้าของงานช่วยทดสอบมือ) | S1–S8 ใน §9 บนอุปกรณ์จริง/โปรเจกต์ทดลอง | Q ใน §8 ตัดสินแล้ว |
| **B15.1** DB | @gb-backend | migration: CHECK `'push'` (2 ตาราง) · `push_subscriptions` + RLS/column GRANT · DB function สมัคร/ถอด/จำกัดจำนวน · `enqueue_notifications` เพิ่ม target `push` · (Q3) ปรับ 3 ฟังก์ชันที่ข้าม fan-out · เทสต์ข้อ 1–3 | Q1, Q3, Q5 |
| **B15.2** ส่ง | @gb-integrations | `deliverPush` + `validatePushEndpoint` + `push-message.ts` + env/flag + rate limit + docs/rate-limits.md · เทสต์ข้อ 4–9 | B15.1 · Q7, Q8, Q10 · `npm install web-push` (ขออนุมัติ) |
| **B15.3** PWA/CSP | @gb-integrations | `public/sw.js`, manifest, icon, `worker-src`, `proxy.ts` matcher, `next.config` headers · เทสต์ข้อ 10–11 | Q4 · ต้องมีไฟล์ icon จาก design |
| **B15.4** UI | @gb-frontend | หน้า "ตั้งค่าการแจ้งเตือน" (#54): สถานะอุปกรณ์/สิทธิ์, toggle รายประเภท, คำแนะนำ iOS, ปุ่มทดสอบ · Playwright ข้อ 12–14 | B15.2–B15.3 · Q5 |
| **ops** | เจ้าของงาน | สร้าง VAPID keys + ตั้ง env บน Vercel (ไม่ส่ง private key ให้ใคร) · เปิด flag หลัง QA | — |

---

## 7. ข้อเสนอสำหรับ `docs/rate-limits.md` และ env (ยังไม่แก้ไฟล์เหล่านั้น)

| env | ที่ | ลับ? |
|---|---|---|
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Vercel (+ `.env.local`) | ไม่ลับ |
| `VAPID_PRIVATE_KEY` | Vercel เท่านั้น | 🔴 ลับ |
| `VAPID_SUBJECT` | Vercel | ไม่ลับ (ส่งให้ push service) |
| `WEB_PUSH_ENABLED` | Vercel (`'true'` ตรงตัว เหมือน `isLinePlatformLoginEnabled`) | ไม่ลับ |

---

## 8. 🔶 คำถามที่ต้องให้เจ้าของงาน/planner ตัดสิน

รูปแบบ: **แผนบอก X / ของจริงคือ Y / ทางเลือกคือ Z** · ★ = ที่แนะนำ

| # | แผนบอก | ของจริงคือ | ทางเลือก |
|---|---|---|---|
| **Q1 เหตุการณ์ไหนส่ง push** | C9: "permission + toggle รายประเภท" (ไม่ระบุว่ารายการไหน) | เหตุการณ์ที่เป็น notification ของผู้ใช้จริงมี **8 ชนิด** (`NotificationList.tsx` EVENT_LABELS + `line-message.ts:24-41`): `waitlist.promoted` (ส่วนตัว+เร่งด่วน) · `session.reminder` · `payment.due` / `payment.overdue` (ส่วนตัว, ข้อความไม่มียอด) · `gang.join_decided` (ส่วนตัว) · `gang.join_requested` (เฉพาะ owner/admin) · `announcement.published` และ `session.opened` (กระจายให้ทั้งก๊วน — เสี่ยงน่ารำคาญ) · นอกนั้น `line.linked`/`line.test` เป็นข้อความของระบบ LINE (ไม่เกี่ยวกับ push) | **★ A:** push ได้ทั้ง 8 ชนิด; ค่าเริ่มต้น **เปิด** 6 ชนิด (`waitlist.promoted`, `session.reminder`, `gang.join_decided`, `payment.due`, `payment.overdue`, `gang.join_requested`) และ **ปิด** 2 ชนิดที่กระจายทั้งก๊วน (`announcement.published`, `session.opened`) — ผู้ใช้เปิดเองได้ · B: เปิดทั้ง 8 ชนิดเป็นค่าเริ่มต้น · C: เฉพาะ 3 ชนิดเร่งด่วน (`waitlist.promoted`, `session.reminder`, `gang.join_decided`) |
| **Q2 ซ้ำกับ LINE ไหม** | ไม่ได้พูด | ผู้ใช้ที่ผูก LINE ของก๊วน **และ** เปิด push จะได้ครบ 3 ช่อง (in-app + LINE + push) ต่อเหตุการณ์ · LINE มีโควต้า 200 ข้อความ/เดือนต่อก๊วน (`20260816000037:31`) · push ไม่มีโควต้า | **★ A:** ส่งทั้งสอง (v1) — ง่าย, ไม่เปลี่ยนพฤติกรรม LINE, push ถึงไม่แน่นอน (iOS ต้องติดตั้ง) จึงไม่ควรไปตัด LINE · B: ถ้าผู้ใช้มี push ที่ส่ง 2xx ได้ใน 30 วัน ให้ **งด LINE** ของเหตุการณ์นั้น (ประหยัดโควต้า แต่ต้องมี logic ใหม่ใน fan-out และถ้า push เงียบจะสูญช่อง) · C: ให้ผู้ใช้เลือกเอง "ช่องที่ต้องการ" ต่อชนิด (ซับซ้อน, ตัดไว้ BACKLOG) |
| **Q3 3 เหตุการณ์ที่ข้าม fan-out** | B15: "ช่อง `push` ในคิวแบบ `<เดิม>:push` เหมือน line" — ประเมินว่าเพิ่มใน `enqueue_notifications` พอ | `waitlist.promoted` / `session.opened` / `payment.due` **insert `in_app` ตรง ไม่ผ่าน `enqueue_notifications`** (§1.2) ⇒ เพิ่ม target ใน `enqueue_notifications` อย่างเดียว **push ไม่ครอบเหตุการณ์ที่สำคัญที่สุด** · LINE ก็ไม่ได้ 3 อันนี้มาตลอด | **★ B:** ให้ฟังก์ชัน 3 ตัวเรียก `enqueue_notifications` แต่เพิ่มพารามิเตอร์ `p_channels text[]` (ค่าเริ่ม `{in_app,line,push}`) แล้วเรียกด้วย `{in_app,push}` ⇒ **ไม่เปลี่ยนพฤติกรรม LINE** (ไม่ดึงโควต้า) · A: ให้ทั้ง LINE+push (LINE ได้ `waitlist.promoted` ที่ควรได้อยู่แล้ว แต่ `session.opened` ส่งถึงทุกสมาชิก ⇒ เผาโควต้า 200/เดือนเร็วมาก ⚠️) · C: ไม่แตะ — push ครอบเฉพาะ 5 ชนิดที่ผ่าน `enqueue_notifications` (ตัด `waitlist.promoted` ออก ซึ่งขัดเจตนา C9) · งานนี้แตะ `promote` ที่เป็น state machine (FOR UPDATE) ⇒ เป็นของ @gb-backend + QA เข้ม |
| **Q4 ต้องมี PWA install prompt ไหม** | "iOS ต้องติดตั้ง PWA ก่อน (manifest)" | ตอนนี้ไม่มี manifest/icon/SW เลย (§1.3) · Next รองรับ manifest โดยตรง · ติดตั้งลงหน้าจอโฮมไม่ต้องมี offline cache (Next PWA guide ระบุว่าให้ trigger install prompt ได้โดยไม่ต้องมี offline) | **★ A:** manifest + icon + คำแนะนำในหน้า "ตั้งค่าการแจ้งเตือน" (ข้อความ/ภาพ "แชร์ → เพิ่มลงหน้าจอโฮม") ไม่ทำ `beforeinstallprompt` เอง · B: เพิ่มปุ่ม "ติดตั้งแอป" ที่ใช้ `beforeinstallprompt` บน Android/desktop · C: ไม่ทำ PWA — push ได้เฉพาะ desktop/Android (iOS ตัดทิ้ง) ⚠️ ผู้ใช้ iPhone อาจเป็นสัดส่วนสำคัญ (ยังไม่มีตัวเลขจริง — วัดหลังเปิดใช้) ⇒ ไม่แนะนำ · **ต้องมีไฟล์ icon จริง (192/512 PNG)** — ใครออกแบบ? |
| **Q5 เก็บการตั้งค่ารายประเภทที่ไหน** | C9: "toggle รายประเภท" | ไม่มีตาราง preference ใดๆ ในฐานข้อมูล (grep `notification_pref`/`preferences` = ไม่พบ) | **★ A:** ตาราง `notification_preferences(user_id pk, push jsonb)` — คีย์ event_type → boolean, ค่าที่ไม่มี = ใช้ค่าเริ่มต้นตาม Q1 (เพิ่ม event ใหม่ไม่ต้อง backfill) · B: คอลัมน์ jsonb ใน `profiles` (ไม่มีตารางใหม่ แต่ผูกกับตารางที่เปิดอ่านกว้างกว่า) · C: ไม่มี toggle รายประเภทใน v1 (เปิด/ปิดทั้งอุปกรณ์เท่านั้น) |
| **Q6 mute รายก๊วน** | ไม่ได้พูด | subscription เป็นระดับอุปกรณ์ ไม่ผูกก๊วน; ผู้ใช้อยู่ได้หลายก๊วน | **★ ไม่ทำใน v1** (BACKLOG) · ทางเลือก: toggle ต่อก๊วนใน `notification_preferences` (ซับซ้อน, UI มาก) |
| **Q7 ตรวจ endpoint (SSRF)** | ไม่ได้พูด | server จะ `POST` ไป URL ที่ client ส่งมา (D6) | **★ A:** https + allow-list โฮสต์ push service ที่รู้จัก (ปลอดภัยสุด; ต้อง spike S3 เก็บโฮสต์จริง — ถ้ามีเบราว์เซอร์ใหม่โผล่ ต้องแก้โค้ด) · B: https + บล็อก private/loopback/link-local หลัง resolve DNS (ยืดหยุ่น แต่ DNS rebinding/TOCTOU ต้องจัดการ — ซับซ้อนกว่า) · C: ทั้งสอง (defense in depth — ช้า/ยุ่งกว่า) |
| **Q8 ไลบรารีส่ง** | ไม่ได้พูด | ไม่มี `web-push` ใน `package.json`; ต้องทำ ECDSA P-256 (VAPID, RFC 8292) + เข้ารหัสข้อความ (RFC 8291) | **★ A:** `web-push` (npm; README ระบุ `setVapidDetails` + `sendNotification` + ตั้ง `TTL`/`urgency`/`topic`; Node-only ซึ่งเรามี `node>=22`) — **ต้องขออนุมัติ `npm install web-push`** ตามกติกาทีม · B: เขียนเองด้วย `node:crypto` (ไม่มี dependency, แต่เสี่ยง bug ด้านเข้ารหัสสูง — ไม่แนะนำ) |
| **Q9 ความหน่วง** | ไม่ได้พูด | ตัวส่งจริงรันทุก 5 นาทีจาก GitHub Actions (ไม่การันตีเวลา — `cron.yml` หัวไฟล์) | **★ A:** ยอมรับ 5–10 นาทีใน v1 (grace ของ `waitlist.promoted` = 3 ชม.) · B: หลังเข้าคิว `waitlist.promoted` เรียก `dispatchNotifications` ต่อท้ายแบบ best-effort (ทันใจ แต่เพิ่มเวลา request ของคนยกเลิก + ต้องไม่ทำให้ action ล้มถ้าส่งไม่ได้) |
| **Q10 `VAPID_SUBJECT`** | ไม่ได้พูด | RFC 8292 §2.1: `sub` ควรเป็น `mailto:` หรือ `https:` URI; ตัว push service ใช้ติดต่อเมื่อมีปัญหา | **★ `https://gang-badminton.vercel.app`** (ไม่ต้องเปิดเผยอีเมลส่วนตัวของเจ้าของงาน) · ทางเลือก: `mailto:` อีเมลติดต่อของเจ้าของงาน |

---

## 9. 🧪 ยังไม่ยืนยัน — ต้อง spike ก่อนเขียนจริง (ห้ามอ้างเป็นข้อเท็จจริง)

| # | อะไร | ทำไมสำคัญ | พิสูจน์ยังไง |
|---|---|---|---|
| **S1** | CSP ปัจจุบัน (`strict-dynamic`) + `worker-src 'self'` ลงทะเบียน SW ได้จริงบนหน้า dynamic **และ** หน้า static โดยไม่มี violation; `sw.js` ที่ผ่าน/ไม่ผ่าน proxy ได้ MIME ถูก (`nosniff`) | ถ้าลงทะเบียนไม่ได้ทั้งฟีเจอร์ล้ม · ต้องรู้ว่า fallback ของ `worker-src` ทำงานอย่างที่เขียนไว้ใน D7 หรือไม่ | Playwright บน build จริง · ตรวจ console + `navigator.serviceWorker.ready` |
| **S2** | การที่ไม่ต้องเพิ่มโฮสต์ push service ใน `connect-src` (เพราะ server ยิงเอง) | ถ้า SDK ฝั่ง client ยิงออกเอง CSP จะบล็อกเงียบ | spike เดียวกับ S1 สังเกต violation ตอน `subscribe()` |
| **S3** | โฮสต์ `endpoint` จริงจากแต่ละแพลตฟอร์ม (Chrome/Android, Firefox, Safari/iOS-standalone, Edge) และพฤติกรรม **404/410 = subscription ตาย** | allow-list (Q7) ต้องมาจากของจริง ไม่ใช่ความจำ · เกณฑ์ลบ subscription ต้องถูก (**RFC 8030 ที่ดึงมารอบนี้ไม่พบข้อความ 404/410 ในส่วนที่อ่านได้ — ไม่ได้ยืนยันจากเอกสารหลัก**) | สมัครจากอุปกรณ์จริง 4 แบบแล้วดู `endpoint`; ลบ subscription ที่ฝั่งเบราว์เซอร์แล้วส่งซ้ำดูสถานะที่ได้ |
| **S4** | เปลี่ยน VAPID key แล้ว subscription เดิมใช้ไม่ได้ (D4) | กำหนดว่า "เปลี่ยน key = ผู้ใช้ต้องสมัครใหม่" ใช่หรือไม่ | ส่งด้วย key ใหม่ไป subscription เก่า ดูสถานะ |
| **S5** | `app/manifest.ts` vs ไฟล์ static ต่อเทสต์ `STATIC_ROUTES` (`csp.test.ts:70-90`) | เลือกวิธีที่ไม่ทำให้เทสต์ล้ม/ไม่ทำให้หน้าขาวเงียบ | `npm run build` แล้วดู `.next/prerender-manifest.json` |
| **S6** | เพดานการ publish ประกาศ/จำนวนผู้รับต่อรอบ (ผู้ดูแลที่ถูกยึดบัญชียิง push ถึงทั้งก๊วน) | T-ปริมาณ · ยังไม่ได้ตรวจ rate limit ของ `announcement` publish | อ่าน `docs/rate-limits.md` ส่วน action ประกาศ + เทสต์ |
| **S7** | LINE in-app browser / LIFF สมัคร push ได้หรือไม่ (WebView) | ผู้ใช้ส่วนใหญ่เข้าจากลิงก์ใน LINE · ถ้าไม่ได้ ต้องบอกให้เปิดด้วยเบราว์เซอร์ | ทดสอบเปิดหน้าตั้งค่าจากลิงก์ใน LINE บน Android/iOS จริง |
| **S8** | พฤติกรรม "เครื่องร่วมหลายบัญชี" (T4): ย้ายเจ้าของ endpoint ตอนผู้ใช้ใหม่เปิดแจ้งเตือน, และสิ่งที่ผู้ใช้เก่าเห็นถ้าไม่ได้ปิด | ความเป็นส่วนตัว | ทดสอบ 2 บัญชีบนเบราว์เซอร์เดียว |
| **S9** | iOS: รับ push ได้เฉพาะ Home Screen web app — **ยืนยันจาก WebKit blog (ก.พ. 2023) และ Next.js PWA guide แล้ว**; ที่ยังไม่ยืนยัน: เวอร์ชัน iOS ล่าสุดที่ผู้ใช้ไทยใช้จริง, พฤติกรรมเมื่อผู้ใช้ลบแอปออกจากหน้าจอโฮม (subscription ตายเมื่อไหร่) | ประมาณการผู้ใช้ที่เข้าถึงได้ | ทดสอบบน iPhone จริง 1–2 เครื่อง |

> ถ้า **S1 ล้ม** (ลงทะเบียน SW ไม่ได้ภายใต้ CSP เข้ม) ⇒ ต้องเลือกระหว่างผ่อน CSP เฉพาะ `/sw.js` กับเลิกฟีเจอร์ ⇒ **ADR นี้ต้องกลับมาทบทวน**
> ถ้า **S3 พบโฮสต์นอกรายการ** ⇒ ปรับ allow-list ก่อนเขียน `validatePushEndpoint`

---

## 10. อ้างอิงภายนอก (ตรวจ 28 ต.ค. 2026)

| เรื่อง | ที่มา | ใช้กับ |
|---|---|---|
| Web Push บน iOS/iPadOS 16.4+ เฉพาะ Home Screen web app; ขอสิทธิ์ต้องมาจาก user gesture; ผู้ใช้จัดการต่อแอปใน Settings | WebKit — *Web Push for Web Apps on iOS and iPadOS* (16 ก.พ. 2023) https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ | D8, D10, Q4 |
| รองรับ: iOS 16.4+ (ติดตั้งลงหน้าจอ), Safari 16 / macOS 13+, Chromium, Firefox · `app/manifest.ts` / `manifest.json` ของ Next · ติดตั้งได้โดยไม่ต้องมี offline support | Next.js — *How to build a PWA with Next.js* https://nextjs.org/docs/app/guides/progressive-web-apps | D3, D10, Q4 |
| ส่งข้อความผ่าน HTTP POST ไปยัง push resource; header `TTL` (§5.2), `Urgency` (§5.3), `Topic` แทนข้อความเก่า (§5.4); subscription มีอายุจำกัดและถูกยกเลิกโดย push service/เบราว์เซอร์ได้ทุกเมื่อ | RFC 8030 *Generic Event Delivery Using HTTP Push* https://www.rfc-editor.org/rfc/rfc8030.html | D5, S3 |
| VAPID: คู่กุญแจ ECDSA P-256 (ES256); JWT claims `aud` (origin ของ push resource), `exp` ≤ 24 ชม.; `sub` ควรเป็น `mailto:` หรือ `https:` URI; จำกัด subscription ให้ application server เดียว | RFC 8292 *VAPID for Web Push* https://www.rfc-editor.org/rfc/rfc8292.html | D4, Q10 |
| ไลบรารี Node: `setVapidDetails`, `sendNotification`, options `TTL`/`urgency`/`topic`/`timeout`; `generate-vapid-keys` | `web-push-libs/web-push` README https://github.com/web-push-libs/web-push | D4, D5, Q8 |
| Push API เป็น Baseline "widely available" ตั้งแต่ มี.ค. 2023 | MDN — Push API https://developer.mozilla.org/en-US/docs/Web/API/Push_API | บริบท |
| (ไม่ได้ดึงรอบนี้) RFC 8291 (การเข้ารหัสข้อความ) — ไลบรารีจัดการให้ ไม่ใช่ตัวตัดสินใจของ ADR นี้ | https://www.rfc-editor.org/rfc/rfc8291.html | Q8 |

*เอกสารนี้เป็นของ WO-B15-ADR · ผู้ดูแล: @gb-integrations · ไม่มีการแก้โค้ด/migration/CSP/ไฟล์อื่นในใบนี้*
