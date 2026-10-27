# เช็คลิสต์ตั้งค่า "เข้าสู่ระบบด้วย LINE" (สำหรับเจ้าของงาน)

> **ใช้กับ:** ADR-013 (`docs/adr/ADR-013-line-login-primary.md`) · ทำครั้งเดียว ใช้เวลาประมาณ 20–30 นาที
> **ต้องมี:** บัญชี LINE ของคุณ (ที่จะเป็นเจ้าของ) + สิทธิ์เข้า Supabase Dashboard ของโปรเจกต์ `gang-badminton`
> **ทำกับโปรเจกต์:** `emmzeriekkjryhucvctx` (ตัวเดียวกับ production — ตอนนี้ยังไม่มีผู้ใช้จริง จึงทดลองได้)

---

## 🔴 กติกาข้อเดียวที่สำคัญที่สุด

**ห้ามส่ง "Channel secret" ให้ใคร รวมถึงบอทและแชทนี้**
- คัดลอกจาก LINE → **วางลง Supabase เอง** แล้วจบ
- ส่งกลับมาได้เฉพาะรายการในกรอบ "📤 ส่งอะไรกลับมาได้" ท้ายแต่ละช่วง
- ถ้าเผลอส่ง secret ไปแล้ว: เข้า LINE Console → Basic settings → ปุ่ม **Issue** ใต้ Channel secret เพื่อออกค่าใหม่ แล้ว **Update** ใน Supabase อีกครั้ง

> ℹ️ **หมายเหตุเรื่องชื่อเมนู:** ผมเขียนจากเอกสารทางการของ LINE/Supabase (ตรวจ 27 ต.ค. 2026) ไม่ได้เห็นหน้าจอของคุณ — ถ้าชื่อปุ่มไม่ตรง ให้ถ่ายหน้าจอ (**บังค่า secret ก่อน**) ส่งมา แล้วผมแก้เช็คลิสต์ให้ตรง

---

## ภาพรวม — ลำดับสำคัญ (สลับไปมา 2 เว็บ)

```
ส่วน A  LINE Console   : สร้าง Provider + Channel          → ได้ Channel ID + Channel secret
ส่วน B  Supabase       : เริ่มสร้าง Custom Provider        → ได้ "Callback URL"  ← ต้องรู้ก่อนไปต่อ
ส่วน C  LINE Console   : วาง Callback URL                  
ส่วน D  Supabase       : กดสร้าง provider + ตั้งค่าอื่น
ส่วน E  ทดลองเข้า       : เช็คว่า LINE พาเข้ามาได้
```

**ทำไมต้องสลับ:** Callback URL สร้างโดย Supabase แต่ต้องเอาไปลงทะเบียนที่ LINE ก่อนถึงจะใช้ได้

---

## ส่วน A — LINE Developers Console: สร้าง Provider และ Channel

### A1. เข้าสู่ระบบ
1. เปิด <https://developers.line.biz/console/>
2. กด **Log in** → เลือก **Log in with LINE account** → ล็อกอินด้วยบัญชี LINE ของคุณ
   - ถ้าถามให้สร้าง "developer name" ให้ตั้งชื่อ (ใช้ชื่อคุณหรือชื่อทีมได้) และใส่อีเมลติดต่อ
   - 💡 ใช้บัญชี LINE ที่ไม่น่าจะหาย/ปิด เพราะเป็นบัญชีเจ้าของ channel

### A2. สร้าง Provider ใหม่
> 🔴 **ต้องเป็น Provider ใหม่เท่านั้น** ห้ามใช้อันเดียวกับ LINE OA ของก๊วนใด — เพราะ LINE ออกรหัสผู้ใช้แยกตาม Provider (ดู ADR-013 §2) และสร้าง channel แล้ว **ย้ายไป provider อื่นไม่ได้อีก**

3. หน้า Console → ปุ่ม **Create** (หรือ **Create a new provider**)
4. ช่อง **Provider name** → พิมพ์ `Gang Badminton Platform` (ชื่อนี้ผู้ใช้จะเห็นตอน LINE ขออนุญาต — ตั้งให้เป็นชื่อจริงที่ใช้ยาวๆ)
5. กด **Create**

### A3. สร้าง LINE Login channel
6. เข้า Provider ที่เพิ่งสร้าง → แท็บ **Channels** → กด **Create a LINE Login channel** (หรือเลือกชนิด **LINE Login**)
7. กรอกฟอร์ม:

   | ช่อง | ใส่อะไร |
   |---|---|
   | **Channel type** | LINE Login (ถูกเลือกให้แล้ว) |
   | **Provider** | Gang Badminton Platform |
   | **Region to provide the service** | **Thailand** |
   | **Company or owner's country or region** | Thailand |
   | **Channel icon** | โลโก้ก็ได้ (ไม่ใส่ก็ได้) |
   | **Channel name** | `Gang Badminton` ⚠️ **ห้ามมีคำว่า "LINE" ในชื่อ** (LINE ไม่อนุญาต) — ชื่อนี้ผู้ใช้เห็นตอนกดเข้าสู่ระบบ |
   | **Channel description** | เช่น `ระบบจัดก๊วนแบดมินตัน` |
   | **App types** | ✅ ติ๊ก **Web app** เท่านั้น (ไม่ต้องติ๊ก Mobile app) |
   | **Email address** | อีเมลติดต่อของคุณ |
   | **Privacy policy URL / Terms of use URL** | เว้นว่างได้ตอนทดลอง (ต้องใส่ก่อนเปิดให้คนทั่วไปใช้) |

8. ติ๊กยอมรับข้อตกลง 2 ข้อ → กด **Create**

### A4. จดค่าที่ต้องใช้
9. เปิด channel ที่สร้างแล้ว → แท็บ **Basic settings**
10. เลื่อนหา:
    - **Channel ID** (เป็นตัวเลข 10 หลักประมาณนี้) → คัดลอกเก็บไว้ ✅ ไม่ลับ
    - **Channel secret** (ตัวอักษรยาว) → 🔴 **คัดลอกเก็บในที่ปลอดภัย เช่น password manager** (จะวางลง Supabase ใน D2)
11. เลื่อนลงไปที่หัวข้อ **OpenID Connect → Email address permission**
    - ✅ **ไม่ต้องกด Apply** (เราตั้งใจไม่ขออีเมลจากผู้ใช้ — ดู ADR-013 §4 R1)
12. ดูแท็บ **Roles** (หรือ Basic settings → Channel's admin/tester) → ตรวจว่าชื่อคุณเป็น **Admin**
    - สถานะ channel ตอนนี้เป็น **Developing** = มีแค่ Admin/Tester ที่ล็อกอินได้ ✅ ถูกแล้วสำหรับตอนทดลอง

> 📤 **ส่งอะไรกลับมาได้ (ส่วน A):** Channel ID · ภาพหน้าจอ Basic settings **โดยบังค่า Channel secret**
> ❌ **ห้ามส่ง:** Channel secret

---

## ส่วน B — Supabase Dashboard: เริ่มสร้าง Custom Provider (เพื่อเอา Callback URL)

1. เปิด <https://supabase.com/dashboard/project/emmzeriekkjryhucvctx/auth/providers>
   (หรือ Dashboard → เลือกโปรเจกต์ **gang-badminton** → เมนูซ้าย **Authentication** → **Sign In / Providers**)
2. เลื่อนลง **ล่างสุดของหน้า** หาหัวข้อ **Custom Providers** → กด **New Provider**
3. ที่ "Configuration method" เลือก **Auto-discovery (OIDC)**
4. กรอก:

   | ช่อง | ค่า |
   |---|---|
   | **Identifier** | `custom:line` (พิมพ์ตรงตัว ตัวเล็กทั้งหมด) |
   | **Name** (ถ้ามีช่อง) | `LINE` |
   | **Client ID** | Channel ID จากข้อ A4 |
   | **Client Secret** | 🔴 วาง Channel secret จาก LINE (ทำที่นี่ที่เดียว) |
   | **Issuer URL** | `https://access.line.me` |
   | **Scopes** | `openid profile` (ห้ามใส่ `email`) |

5. มองหาตัวเลือกชื่อประมาณ **Email optional** (หรือ "Allow sign-in without email") → ✅ **เปิด**
   - ⚠️ **ถ้าหน้าจอไม่มีตัวเลือกนี้:** อย่าเพิ่งกดสร้าง — ถ่ายหน้าจอส่งมา (ผมจะดูว่าต้องตั้งผ่านทางอื่น) ถ้าไม่เปิด ผู้ใช้ LINE จะเข้าไม่ได้เพราะ LINE ไม่ส่งอีเมล
6. 🔴 **ยังไม่กด Create** — หาช่อง **Callback URL** (อ่านอย่างเดียว) บนฟอร์มเดียวกัน
   - ค่าควรเป็น `https://emmzeriekkjryhucvctx.supabase.co/auth/v1/callback`
   - กดไอคอนคัดลอก (**อย่าเปิดหน้านี้ทิ้ง** — ถ้าออกจากฟอร์ม ต้องกรอกใหม่)

> 📤 **ส่งอะไรกลับมาได้ (ส่วน B):** ค่า Callback URL (ไม่ลับ) · ภาพหน้าจอฟอร์ม **โดยบังช่อง Client Secret**

---

## ส่วน C — LINE Console: ลงทะเบียน Callback URL

1. กลับไป LINE Console → channel `Gang Badminton` → แท็บ **LINE Login**
2. ช่อง **Callback URL** → กด **Edit** → วาง URL จากข้อ B6 **ให้ตรงทุกตัวอักษร** (ห้ามมี `/` ต่อท้ายเพิ่ม ห้ามมีช่องว่าง)
3. กด **Update** / **Save**
4. ตรวจที่แท็บ **Basic settings** → **App types** ยังเป็น **Web app**

---

## ส่วน D — Supabase: กดสร้าง + ตั้งค่าที่เกี่ยวข้อง

### D1. สร้าง provider
1. กลับหน้า Supabase ที่ค้างไว้ (ส่วน B) → กด **Create and enable provider**
2. ควรเห็น `custom:line` ในรายการ Custom Providers สถานะ enabled

### D2. เปิด Manual Linking (ใช้ผูก LINE กับบัญชีอีเมลเดิมของคุณตอนล็อกอินอยู่)
3. หน้าเดิม **Authentication → Sign In / Providers** เลื่อนหาตัวเลือก **Allow manual linking** (อาจอยู่ใต้หัวข้อ User Signups / Settings)
4. เปิดสวิตช์ → **Save**
   - ถ้าหาไม่เจอ: ถ่ายหน้าจอส่งมา

### D3. ตรวจ Redirect URLs (**ดูก่อน อย่าลบของเดิม**)
5. เมนูซ้าย **Authentication → URL Configuration**
6. ดูที่ **Redirect URLs** — ต้องมีบรรทัดนี้ (ถ้ายังไม่มีให้กด **Add URL** แล้วเพิ่ม):
   - `https://gang-badminton.vercel.app/auth/callback`
7. 🔴 **ห้ามแก้ Site URL** และห้ามลบ URL ที่มีอยู่เดิม
8. กด **Save**

> 📤 **ส่งอะไรกลับมาได้ (ส่วน D):** ภาพหน้าจอรายการ Custom Providers (ไม่มี secret แสดงอยู่) · ภาพหน้า URL Configuration · บอกว่าเปิด Manual Linking ได้หรือไม่

---

## ส่วน E — ทดลองเข้าสู่ระบบ (spike S1/S3)

> ทดลองด้วยบัญชี LINE ของคุณเอง (เป็น Admin ของ channel อยู่แล้ว จึงเข้าได้แม้ channel ยังเป็น Developing)

1. เปิดหน้าต่าง **Incognito/Private** ในเบราว์เซอร์ (กันปนกับ session เดิม)
2. เปิด URL นี้:
   `https://emmzeriekkjryhucvctx.supabase.co/auth/v1/authorize?provider=custom:line`
3. ควรเห็น **หน้า LINE ขออนุญาต** (ชื่อ channel `Gang Badminton`) → กดอนุญาต / ล็อกอิน LINE
4. หลังอนุญาต เบราว์เซอร์จะกลับมาที่เว็บเรา (อาจแสดงหน้าอะไรก็ได้ — **ไม่เป็นไร ตอนนี้ยังไม่มีปุ่มในแอป**)
   - 🔴 URL ตอนกลับมาอาจมีรหัสยาวๆ (`access_token=…` หลังเครื่องหมาย `#`) → **ห้ามคัดลอก URL นั้นส่งใคร** แล้วปิดหน้าต่างทิ้ง
5. ตรวจผลที่ Supabase → **Authentication → Users**:
   - ควรมีผู้ใช้ใหม่ 1 แถว คอลัมน์ Provider เป็น `custom:line` (หรือคล้ายกัน) และ **คอลัมน์อีเมลว่าง**
6. ตรวจชื่อ: **Table Editor → ตาราง `profiles`** → แถวล่าสุด `display_name` (ถ้าเป็น `สมาชิกใหม่` = ปกติ ตอนนี้ trigger ยังไม่อ่านชื่อจาก LINE — ADR-013 §4.4)
7. ตรวจข้อมูลที่ LINE ส่งมา: ที่ Users คลิกแถวนั้นดู **User metadata / Raw user meta data** → จดว่ามี key อะไรบ้าง (เช่น `name`, `picture`)
   - ❌ **ห้ามส่งค่าอีเมล/โทเคน/รหัสผู้ใช้ (sub) ที่ยาวๆ มา** ส่งเฉพาะ "ชื่อ key" ก็พอ

### ถ้าเจอปัญหา

| อาการ | น่าจะเป็นเพราะ | ทำอะไร |
|---|---|---|
| LINE ขึ้น `redirect_uri` ไม่ตรง (400) | Callback URL ใน LINE ไม่ตรงกับของ Supabase | ทำส่วน C ใหม่ วางให้ตรงทุกตัวอักษร |
| ขึ้น error จาก Supabase เรื่อง email | ยังไม่ได้เปิด Email optional | ส่งภาพหน้าจอมา (ดู B5) |
| LINE บอก "ไม่มีสิทธิ์" / channel ไม่พร้อม | ล็อกอินด้วยบัญชี LINE ที่ไม่ใช่ Admin/Tester | เพิ่มบัญชีนั้นที่แท็บ **Roles** หรือใช้บัญชีเจ้าของ |
| ไม่เห็นผู้ใช้ใน Users | flow ไม่จบ | ส่งภาพหน้าจอตอนจบ (ลบ `#…` ใน URL ก่อน) |

> 📤 **ส่งอะไรกลับมาได้ (ส่วน E):** ผ่าน/ไม่ผ่าน · ข้อความ error ที่เห็น · ชื่อ key ใน User metadata · ภาพหน้าจอแถว Users (บังอีเมล/ID)

---

## ส่วน F — ทำทีหลัง (ยังไม่ต้องทำตอนนี้)

- **เปลี่ยน channel เป็น Published** (ปุ่มสถานะบนสุดของหน้า channel ใน LINE Console) — ทำเมื่อพร้อมให้เพื่อนในก๊วนลองจริง (UAT) ไม่งั้นคนอื่นที่ไม่ใช่ Admin/Tester เข้าไม่ได้ · ก่อน Publish ควรใส่ Privacy policy URL
- **ผูก LINE กับบัญชีอีเมลเดิมของคุณ** — ทำผ่านปุ่มในแอปตอนที่ผมทำ WO-B1 เสร็จ (ตอนนี้ยังไม่มี)
- **ตั้ง `APP_BASE_URL` บน Vercel** ให้ตรงโดเมนจริง (`https://gang-badminton.vercel.app`) — เดี๋ยวผมแจ้งตอนถึงขั้นนั้น (Vercel → Project → Settings → Environment Variables)

---

## สรุปของที่ "ห้ามส่ง" vs "ส่งได้"

| ✅ ส่งได้ | ❌ ห้ามส่งเด็ดขาด |
|---|---|
| Channel ID | **Channel secret** |
| Callback URL | Supabase service-role key / secret key |
| ภาพหน้าจอ (บังช่อง secret) | URL ที่มี `#access_token=…` |
| ชื่อ key ใน User metadata | อีเมล / sub / โทเคนจริงของผู้ใช้ |
| ข้อความ error | รหัสผ่านใดๆ |

---

*เอกสารนี้เป็นของ WO-B1 · ผู้ดูแล: @gb-integrations · อ้างอิง: ADR-013 §6–§8, §10 (spike S1, S3)*
