import { LineAccountPanel } from './LineAccountPanel';
import { myLineAccount } from '@/server/actions/line-identity';

/**
 * ส่วน "เข้าสู่ระบบด้วย LINE" บนหน้าโปรไฟล์ — **[WO-B1.c]** server component
 *
 * วางหน้าเดียวพอ: `<LineAccountSection />` (ไม่ต้องส่ง prop — อ่านผู้ใช้จาก session เอง)
 * flag `LINE_PLATFORM_LOGIN_ENABLED` ปิด / อ่านสถานะไม่ได้ ⇒ ไม่ render อะไรเลย (หน้าโปรไฟล์ไม่พัง)
 * ต้องอยู่ในหน้าที่เป็น `force-dynamic` (อ่าน session) ซึ่ง `/profile` เป็นอยู่แล้ว
 */
export async function LineAccountSection() {
  const result = await myLineAccount();

  if (!result.success || !result.data.enabled) return null;

  return <LineAccountPanel initial={result.data} />;
}
