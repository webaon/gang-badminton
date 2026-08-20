import type { NextConfig } from 'next';

import { staticSecurityHeaders } from './lib/security/csp';

/**
 * 🔴 **[WO-5.B]** security headers — baseline §Security Checklist
 *
 * ที่นี่ใส่เฉพาะ header ที่ **เหมือนกันทุก request** · `Content-Security-Policy`
 * อยู่ใน `proxy.ts` แทน เพราะต้องมี **nonce ต่อ request** ซึ่ง config แบบ static ทำไม่ได้
 *
 * ⚠️ `headers()` ครอบทุก path รวมไฟล์ static — ต่างจาก matcher ของ `proxy.ts`
 *    ที่ตัด `_next/static` ออก ⇒ สองที่นี้จงใจไม่เหมือนกัน
 */
const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/:path*',
        headers: staticSecurityHeaders(process.env.NODE_ENV === 'production'),
      },
    ];
  },
};

export default nextConfig;
