import type { ComponentType, ReactNode, SVGProps } from 'react';

import type { NavIconKey } from '@/domain/navigation/gang-menu';

/**
 * ไอคอนของเมนูใน shell — **[WO-6.1a]**
 *
 * Astryx มีไอคอนเชิงความหมายแค่ ~28 ชื่อ (ไม่มี wallet/trophy/users…) และกติกาข้อ 2 ของ CLAUDE.md §1
 * ให้เขียน custom ใน `components/ui/` — จึงวาดเองเป็น SVG เส้น (stroke = currentColor)
 * ส่งให้ `<Icon icon={...}>` ของ Astryx ซึ่งคุมขนาด/สีให้ ⇒ ไม่เพิ่ม dependency
 */
type IconProps = SVGProps<SVGSVGElement>;

function base(children: ReactNode) {
  const Component = (props: IconProps) => (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  );
  return Component;
}

export const NAV_ICONS: Record<NavIconKey, ComponentType<IconProps>> = {
  calendar: base(
    <>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M8 3v4M16 3v4M3 10h18" />
    </>,
  ),
  wallet: base(
    <>
      <path d="M4 7a2 2 0 0 1 2-2h11v4" />
      <path d="M4 7v10a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1V10a1 1 0 0 0-1-1H6a2 2 0 0 1-2-2Z" />
      <circle cx="16" cy="14" r="1" />
    </>,
  ),
  trophy: base(
    <>
      <path d="M8 4h8v5a4 4 0 0 1-8 0V4Z" />
      <path d="M8 6H5a2 2 0 0 0 2 4M16 6h3a2 2 0 0 1-2 4M12 13v4M8 21h8M10 17h4" />
    </>,
  ),
  user: base(
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>,
  ),
  home: base(
    <>
      <path d="M3 11 12 4l9 7" />
      <path d="M5 10v10h5v-6h4v6h5V10" />
    </>,
  ),
  users: base(
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.2A6.5 6.5 0 0 1 21.5 20" />
    </>,
  ),
  chart: base(
    <>
      <path d="M4 20V10M10 20V4M16 20v-8M22 20H2" />
    </>,
  ),
  megaphone: base(
    <>
      <path d="M3 10v4a1 1 0 0 0 1 1h3l8 4V5L7 9H4a1 1 0 0 0-1 1Z" />
      <path d="M19 9a4 4 0 0 1 0 6" />
    </>,
  ),
  settings: base(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </>,
  ),
  chat: base(
    <>
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12Z" />
    </>,
  ),
  repeat: base(
    <>
      <path d="M17 2l4 4-4 4" />
      <path d="M3 11V9a3 3 0 0 1 3-3h15" />
      <path d="M7 22l-4-4 4-4" />
      <path d="M21 13v2a3 3 0 0 1-3 3H3" />
    </>,
  ),
  inbox: base(
    <>
      <path d="M3 13h5l1 3h6l1-3h5" />
      <path d="M5.5 5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5l2.5-8Z" />
    </>,
  ),
  star: base(
    <>
      <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3Z" />
    </>,
  ),
};
