# Error Catalog

> **แหล่งเดียว (single source of truth) ของ `error.code` ทั้งระบบ** — baseline v3.3 §Engineering Practices
>
> - `error.code` ที่ปรากฏใน API response contract `{ success, data?, error: { code, message } }` **ต้องมาจากไฟล์นี้เท่านั้น**
> - DB functions raise ด้วย code เดียวกัน → helper map เป็น `ErrorCode`
> - frontend **แปลภาษาจาก code** — ❌ ห้าม hardcode ข้อความ error กระจายตามไฟล์
> - log ค้นด้วย code
> - **เพิ่ม code ใหม่ = เพิ่มในไฟล์นี้ก่อน** แล้วค่อยใช้ในโค้ด

---

## Convention การ raise จาก Postgres

DB function raise ด้วย `ERRCODE = 'P0001'` (raise_exception) และใส่ **code ไว้ที่ `MESSAGE`** ตรงๆ
รายละเอียดที่ frontend ต้องใช้ (เช่น จำนวนที่ว่าง, สถานะจริง) ใส่ที่ `DETAIL` เป็น JSON

```sql
RAISE EXCEPTION USING
  ERRCODE = 'P0001',
  MESSAGE = 'SESSION_FULL',
  DETAIL  = json_build_object('session_id', p_session_id, 'max_players', v_max)::text;
```

ฝั่ง TypeScript: helper ใน `shared/` อ่าน `PostgrestError.message` → เทียบกับ `ErrorCode` union
→ ถ้าไม่ตรงตัวไหนเลย = `INTERNAL_ERROR` (และต้อง log ของเดิมไว้เต็ม ห้าม swallow)

---

## Registration / Session

| Code | HTTP | ความหมาย | raise จาก |
|---|---|---|---|
| `SESSION_FULL` | 409 | นัดเต็มแล้ว (`count(confirmed) >= max_players`) — ปกติจะถูกส่งเข้า waitlist แทน ไม่ใช่ error เว้นแต่ waitlist ปิด | `register_to_session()` |
| `SESSION_NOT_OPEN` | 409 | นัดไม่ได้อยู่สถานะ `open` — ลงชื่อไม่ได้ | `register_to_session()` |
| `ALREADY_REGISTERED` | 409 | คนนี้ลงชื่อในนัดนี้อยู่แล้ว (ชน partial unique index) | `register_to_session()` |
| `REGISTRATION_NOT_FOUND` | 404 | ไม่พบ registration หรือถูก soft delete ไปแล้ว | ทุก function ที่รับ `registration_id` |
| `CANCEL_CUTOFF_PASSED` | 409 | เลยเวลา cutoff ตาม cancellation policy ใน snapshot — ยกเลิกได้แต่โดน penalty (ใช้เป็น error เฉพาะกรณีก๊วนตั้งค่าห้ามยกเลิกหลัง cutoff) | `cancel_registration()` |
| `INVALID_REGISTRATION_TRANSITION` | 409 | transition ที่ไม่อนุญาต เช่น `waitlist → checked_in` ตรง | `check_in_registration()` |

## State machine

| Code | HTTP | ความหมาย | raise จาก |
|---|---|---|---|
| `INVALID_TRANSITION` | 409 | transition นอก state machine **หรือ** `expected_status` ไม่ตรงกับสถานะจริง (optimistic guard — ADR-001) → ฝั่ง server ต้องคำนวณใหม่แล้ว retry | `transition_session()`, `close_session_with_charges()`, payment trigger |
| `DIRECT_STATUS_UPDATE_FORBIDDEN` | 500 | มีคนพยายาม `UPDATE status` ตรงโดยไม่ผ่าน DB function (ไม่มี GUC `app.allow_transition`) — **เป็นบั๊กของโค้ดเราเสมอ ไม่ใช่ความผิด user** | BEFORE UPDATE trigger ของ `sessions` / `payments` |

## Payment / Billing

| Code | HTTP | ความหมาย | raise จาก |
|---|---|---|---|
| `PAYMENT_ALREADY_VERIFIED` | 409 | payment ถูก verify ไปแล้ว แก้ไม่ได้ — ต้องใช้ `payment_adjustments` แทน | payment trigger / server action |
| `PAYMENT_NOT_FOUND` | 404 | ไม่พบ payment | server action |
| `ALLOCATION_EXCEEDS_PAYMENT` | 409 | `sum(allocations) > payment.amount` — ผิด invariant | CHECK/trigger บน `payment_allocations` |
| `CHARGE_NOT_FOUND` | 404 | ไม่พบ `session_charge` ที่ adjustment อ้างถึง | `payment_adjustments` FK |
| `CHARGES_ALREADY_COMMITTED` | 409 | session นี้ commit charges ไปแล้ว — เรียก `close_session_with_charges()` ซ้ำไม่ได้ | `close_session_with_charges()` |
| `MONTHLY_FEE_ALREADY_GENERATED` | 409 | สมาชิก+เดือนนี้ generate `monthly_fee` ไปแล้ว (idempotency guard) | MembershipBilling function |

## Guest / Invite token

| Code | HTTP | ความหมาย | raise จาก |
|---|---|---|---|
| `INVITE_TOKEN_INVALID` | 401 | token hash ไม่ตรงกับแถวใดใน `session_invite_tokens` | `register_to_session()` (guest path) |
| `INVITE_TOKEN_EXPIRED` | 401 | เลย `expires_at` | `register_to_session()` (guest path) |
| `INVITE_TOKEN_EXHAUSTED` | 409 | ใช้ครบ `max_uses` แล้ว | `register_to_session()` (guest path) |
| `GUEST_ACCESS_DENIED` | 403 | `guest_access_token_hash` ไม่ตรง หรือใช้ token ข้าม session | server action ของหน้า guest |

## Permission / Tenancy / Feature flag

| Code | HTTP | ความหมาย | raise จาก |
|---|---|---|---|
| `UNAUTHENTICATED` | 401 | ไม่มี session ของ Supabase Auth | middleware / server action |
| `FORBIDDEN` | 403 | role ไม่พอตาม `domain/permissions/can()` | `can()` guard |
| `NOT_GANG_MEMBER` | 403 | ไม่ใช่สมาชิกก๊วนนี้ (RLS ปฏิเสธ) | RLS policy / security definer fn |
| `FEATURE_DISABLED` | 403 | ฟีเจอร์ถูกปิดใน `gangs.features` (เช่น รับ guest ทั้งที่ `features.guests = false`) — **ต้องตรวจฝั่ง server เสมอ ไม่ใช่แค่ซ่อนปุ่ม** | `can()` + DB function ที่เกี่ยวข้อง |

## Infrastructure

| Code | HTTP | ความหมาย | raise จาก |
|---|---|---|---|
| `RATE_LIMITED` | 429 | เกิน limit ต่อ IP ต่อ session (`check_rate_limit()` — counter ใน Postgres) | route handler ของ endpoint guest/public |
| `CRON_UNAUTHORIZED` | 401 | `CRON_SECRET` ไม่ตรง | cron route handler |
| `WEBHOOK_SIGNATURE_INVALID` | 401 | LINE signature verify ไม่ผ่าน | `/api/line/webhook/[gangId]` |
| `VALIDATION_ERROR` | 400 | input ไม่ผ่าน schema validation | server action / route handler |
| `NOT_FOUND` | 404 | resource ทั่วไปไม่พบ (ใช้เมื่อไม่มี code เฉพาะทาง) | ทุกที่ |
| `INTERNAL_ERROR` | 500 | ข้อผิดพลาดที่ไม่ได้จัดหมวด — **ต้อง log ต้นฉบับเต็มพร้อม correlation id เสมอ** | ทุกที่ |

---

## หมายเหตุการดูแลไฟล์นี้

- code ที่ baseline v3.3 ระบุชื่อไว้ตรงๆ: `SESSION_FULL`, `INVALID_TRANSITION`,
  `PAYMENT_ALREADY_VERIFIED`, `INVITE_TOKEN_EXPIRED`, `FEATURE_DISABLED`
  — ที่เหลือ**อนุมานจากพฤติกรรมที่ baseline กำหนด** (DB functions, state machines, invariants,
  security checklist) และจะถูกยืนยัน/ปรับตอน **WO-1.3** ที่เขียน DB functions จริง
- ถ้า WO-1.3 พบว่าต้องเพิ่ม/ตัด code ใด → แก้ไฟล์นี้ในคอมมิตเดียวกับโค้ด และระบุใน PR description
- TypeScript `ErrorCode` union จะถูก generate/เขียนที่ `shared/` ตอน WO ที่ต้องใช้จริงครั้งแรก
