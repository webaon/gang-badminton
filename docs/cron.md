# Cron — ใครขับงานอะไร

> 🔴 **[deploy 20 ส.ค. 2026]** Vercel **Hobby** อนุญาต cron ได้ **วันละครั้งต่อ job**
> ⇒ `vercel.json` จึงเหลือรายวันทั้งหมด และทำหน้าที่เป็น **เส้นสำรอง** เท่านั้น

ทุกงานเป็น **idempotent** ⇒ ซ้อนกันได้ปลอดภัย (CLAUDE.md §2.1 · WO-1.5)

| งาน | ตัวขับหลัก | ความถี่ | เส้นสำรอง |
|---|---|---|---|
| waitlist sweep | **pg_cron** (`0012`) | ตามที่ตั้งใน DB | Vercel รายวัน |
| notification sweep (คืนแถวค้าง) | **pg_cron** (`0012`) | ตามที่ตั้งใน DB | Vercel รายวัน |
| purge rate limits | **pg_cron** (`0012`) | ตามที่ตั้งใน DB | Vercel รายวัน |
| rollup (`member_statistics` · `daily_metrics`) | **pg_cron** (`0030`) | รายคืน | Vercel รายวัน |
| **notification dispatch (ส่งจริง)** | **GitHub Actions** (`.github/workflows/cron.yml`) | ทุก 5 นาที | Vercel รายวัน |
| **reminders** (เตือนนัด/ยอดค้าง) | **GitHub Actions** | รายชั่วโมง | Vercel รายวัน |
| ออกบิลรายเดือน | Vercel | รายวัน | ปุ่มสั่งเองในหน้าตั้งค่า |
| generate นัดจากตาราง | Vercel | รายวัน | ปุ่มสั่งเองในหน้าตาราง |

## ทำไมต้องมี GitHub Actions

`notification-dispatch` คือตัวที่ **ส่งข้อความจริง** (in-app + LINE) — ถ้ารันวันละครั้ง
ผู้ใช้จะได้รับแจ้งเตือนช้าถึง 24 ชม. ซึ่งทำให้ฟีเจอร์เตือนแทบไร้ประโยชน์
⇒ ใช้ GitHub Actions (ฟรี) ยิง `/api/cron/<job>` พร้อม `Authorization: Bearer $CRON_SECRET`
ซึ่งเป็นเส้นทางเดียวกับที่ Vercel Cron ใช้ (route handler เดิม ตรวจ secret แบบ timing-safe)

⚠️ GitHub Actions **ไม่การันตีเวลาเป๊ะ** (คิวอาจดีเลย์หลายนาทีตอนระบบคนใช้เยอะ)
— รับได้เพราะงานทั้งหมด idempotent และ pg_cron ยังกวาดของค้างให้อีกชั้น

## ถ้าอัปเป็น Vercel Pro

ย้าย `notification-dispatch` (`*/2 * * * *`) และ `reminders` (`5 * * * *`) กลับไปที่ `vercel.json`
แล้วปิด workflow นี้ได้เลย — ไม่ต้องแก้โค้ดแอปแม้แต่บรรทัดเดียว
