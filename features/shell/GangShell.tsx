'use client';

import { useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { AppShell, useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Icon } from '@astryxdesign/core/Icon';
import { List, ListItem } from '@astryxdesign/core/List';
import { SideNav, SideNavItem } from '@astryxdesign/core/SideNav';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { TopNav } from '@astryxdesign/core/TopNav';
import { VStack } from '@astryxdesign/core/VStack';

import { NAV_ICONS } from '@/components/ui/NavIcons';
import { activeMenuId, type MenuItem } from '@/domain/navigation/gang-menu';

export type ShellGang = { id: string; name: string; roleLabel: string };

type Props = {
  gangId: string;
  gangName: string;
  /** แท็บล่างมือถือ — สร้างฝั่ง server จาก `can()` ผ่าน `buildGangMenu()` */
  tabs: MenuItem[];
  /** sidebar เดสก์ท็อป / drawer มือถือ */
  side: MenuItem[];
  /** ก๊วนทั้งหมดของผู้ใช้ — สำหรับ #59 สลับก๊วน */
  gangs: ShellGang[];
  children: ReactNode;
};

/**
 * โครงหน้าใต้ `/gangs/[gangId]/*` — **[WO-6.1a]**
 *
 *   มือถือ (< md)    : header (ชื่อก๊วน = ปุ่มสลับก๊วน + ปุ่มเมนู → drawer) + tab bar ล่าง 4 ช่อง
 *   เดสก์ท็อป (≥ md)  : TopNav + SideNav (Astryx AppShell)
 *
 * 🔴 shell ไม่ใช่ชั้นสิทธิ์ — รายการเมนูมาจาก `buildGangMenu()` (ใช้ `can()`) แต่ทุกหน้ายังตรวจสิทธิ์ฝั่ง server เอง
 */
export function GangShell({ gangId, gangName, tabs, side, gangs, children }: Props) {
  const pathname = usePathname();
  const [isSwitcherOpen, setSwitcherOpen] = useState(false);

  // LIFF ทำงานในแอป LINE ที่มีกรอบของตัวเอง — ไม่ใส่ shell ซ้อน
  // กระดานคิวสด (WO-6.4a) เป็นจอเต็มสำหรับเปิดค้างที่สนาม — ไม่มี header/tab bar ซ้อน
  if (pathname.endsWith('/liff') || pathname.endsWith('/console/board')) return <>{children}</>;

  const activeSide = activeMenuId(pathname, side);
  const activeTab = activeMenuId(pathname, tabs);

  return (
    <AppShell
      variant="section"
      height="auto"
      // mobile-first: SSR ออกแบบมือถือก่อน (ผู้ใช้หลักเปิดจากมือถือที่สนาม) แล้วค่อยปรับเป็นเดสก์ท็อปตอน hydrate
      mobileNav={{ breakpoint: 'md', defaultIsMobile: true }}
      topNav={
        <TopNav
          label="ก๊วน"
          heading={
            <Button
              variant="ghost"
              label={gangName}
              tooltip="สลับก๊วน"
              endContent={<Icon icon="chevronDown" size="sm" />}
              onClick={() => setSwitcherOpen(true)}
            />
          }
        />
      }
      sideNav={
        <SideNav>
          {side.map((item) => (
            <SideNavItem
              key={item.id}
              label={item.label}
              href={item.href}
              icon={<Icon icon={NAV_ICONS[item.icon]} />}
              isSelected={item.id === activeSide}
            />
          ))}
        </SideNav>
      }
    >
      <ShellBody tabs={tabs} activeTab={activeTab}>
        {children}
      </ShellBody>

      <Dialog isOpen={isSwitcherOpen} onOpenChange={setSwitcherOpen}>
        <DialogHeader title="ก๊วนของฉัน" onOpenChange={setSwitcherOpen} />
        <List>
          {gangs.map((g) => (
            <ListItem
              key={g.id}
              label={g.name}
              description={g.roleLabel}
              href={`/gangs/${g.id}/sessions`}
              isSelected={g.id === gangId}
              onClick={() => setSwitcherOpen(false)}
            />
          ))}
          <ListItem
            label="เข้าร่วมหรือสร้างก๊วนใหม่"
            href="/gangs"
            onClick={() => setSwitcherOpen(false)}
          />
        </List>
      </Dialog>
    </AppShell>
  );
}

/**
 * เนื้อหา + tab bar ล่าง (เฉพาะมือถือ)
 * แยกเป็นคอมโพเนนต์ย่อยเพราะ `useAppShellMobile()` อ่านได้เฉพาะ**ใต้** AppShell —
 * ใช้ breakpoint เดียวกับ AppShell เอง ⇒ sidebar กับ tab bar ไม่มีทางโผล่พร้อมกัน
 */
function ShellBody({
  tabs,
  activeTab,
  children,
}: {
  tabs: MenuItem[];
  activeTab: string | null;
  children: ReactNode;
}) {
  const { isMobile } = useAppShellMobile();
  const showTabs = isMobile && tabs.length > 0;

  return (
    <>
      {children}

      {showTabs ? (
        <>
          {/* กันเนื้อหาท้ายหน้าไปซ่อนใต้ tab bar */}
          <VStack paddingBlock={10} aria-hidden="true" />
          <VStack className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-card">
            <TabList
              value={activeTab ?? ''}
              onChange={() => {
                /* นำทางด้วย href ของแต่ละ Tab */
              }}
              layout="fill"
              size="md"
            >
              {tabs.map((item) => (
                <Tab
                  key={item.id}
                  value={item.id}
                  label={item.label}
                  href={item.href}
                  icon={<Icon icon={NAV_ICONS[item.icon]} />}
                />
              ))}
            </TabList>
          </VStack>
        </>
      ) : null}
    </>
  );
}
