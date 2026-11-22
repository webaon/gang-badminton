import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DashboardSummary, type DashboardSummaryData } from '@/features/dashboard/DashboardSummary';
import { DashboardDetails } from '@/features/dashboard/DashboardDetails';
import type { DashboardOverview } from '@/server/actions/dashboard';

vi.mock('@/components/ui/SimpleTable', () => ({ SimpleTable: ({ rows }: { rows: unknown[] }) => React.createElement('table', null, React.createElement('caption', null, JSON.stringify(rows))) }));
vi.mock('@astryxdesign/core/Button', () => ({ Button: ({ href, label }: { href: string; label: string }) => React.createElement('a', { href }, label) }));

vi.mock('@astryxdesign/core/Card', () => ({ Card: ({ children }: { children: React.ReactNode }) => React.createElement('section', { 'data-card': true }, children) }));
vi.mock('@astryxdesign/core/VStack', () => ({ VStack: ({ children }: { children: React.ReactNode }) => React.createElement('section', null, children) }));
vi.mock('@astryxdesign/core/Grid', () => ({ Grid: ({ children }: { children: React.ReactNode }) => React.createElement('section', null, children) }));
vi.mock('@astryxdesign/core/Heading', () => ({ Heading: ({ children }: { children: React.ReactNode }) => React.createElement('h2', null, children) }));
vi.mock('@astryxdesign/core/Text', () => ({ Text: ({ children }: { children: React.ReactNode }) => React.createElement('p', null, children) }));

const data: DashboardSummaryData = {
  memberCount: 24, newMembersThisMonth: 3, sessionsThisMonth: 9,
  unclosedSessionsCount: 2, joinRequestsPending: 3,
  outstanding: { amount: '1440.00', debtors: 7 },
  pendingSlips: { count: 3, oldestDays: 2 },
  netCashThisMonth: '-2180.00', creditOutstanding: '150.00',
};
const html = (value: DashboardSummaryData) => renderToStaticMarkup(React.createElement(DashboardSummary, { data: value }));

const overview: DashboardOverview = {
  ...data,
  nextSession: { id: 's1', title: 'นัดทดสอบ', startsAt: '2026-11-01T12:00:00Z', endsAt: '2026-11-01T14:00:00Z', status: 'open', courtCount: 2, maxPlayers: 20, courtLabels: ['A', 'B'], seatedCount: 14, waitlistCount: 2, guestCount: 1 },
  followingSession: null,
  avgAttendeesThisMonth: { totalSeated: 29, sessionCount: 2 },
  monthlyCashFlow: [{ month: '2026-11', inflow: '99999999999999999.01', outflow: '10.00', inRatio: 1, outRatio: 0 }],
  recentActivity: [{ id: 'e1', createdAt: '2026-11-01T12:00:00Z', title: 'ลงชื่อนัด', detail: null, actorName: 'ผู้เล่น', adminOnly: false }],
  viewerDisplayName: 'ผู้ทดสอบ',
};
const details = (value: DashboardOverview) => renderToStaticMarkup(React.createElement(DashboardDetails, { data: value, gangId: 'g1' }));

describe('dashboard remaining widgets', () => {
  it('renders four detail cards, preserving money string precision and Bangkok time', () => {
    const result = details(overview);
    expect(result.match(/data-card/g)).toHaveLength(4);
    expect(result).toContain('14.5');
    expect(result).toContain('19:00');
    expect(result).toContain('฿99,999,999,999,999,999.01');
    expect(result).toContain('/gangs/g1/sessions/s1');
    expect(result).toContain('ลงชื่อนัด');
  });
  it('hides unavailable session/cash-flow cards and avoids division by zero', () => {
    const result = details({ ...overview, nextSession: null, monthlyCashFlow: null, avgAttendeesThisMonth: { totalSeated: 0, sessionCount: 0 }, recentActivity: [] });
    expect(result.match(/data-card/g)).toHaveLength(2);
    expect(result).not.toContain('นัดถัดไป');
    expect(result).not.toContain('เงินเข้า / เงินออก');
    expect(result).toContain('—');
    expect(result).toContain('ยังไม่มีเหตุการณ์');
    expect(result).not.toMatch(/NaN|Infinity/);
  });
});

describe('dashboard summary: server data and whole-card null gates', () => {
  it('renders eight supported summary widgets with server amounts unchanged', () => {
    const result = html(data);
    expect(result.match(/data-card/g)).toHaveLength(8);
    expect(result).toContain('฿1,440.00');
    expect(result).toContain('-฿2,180.00');
    expect(result).toContain('เงินสดสุทธิเดือนนี้');
    expect(result).not.toContain('กำไร');
  });
  it.each([
    ['outstanding', 'ค้างจ่าย'], ['pendingSlips', 'สลิปรอตรวจ'],
    ['netCashThisMonth', 'เงินสดสุทธิเดือนนี้'], ['creditOutstanding', 'เครดิตสมาชิกคงค้าง'],
    ['unclosedSessionsCount', 'นัดที่ยังไม่ปิดรอบ'], ['joinRequestsPending', 'คำขอเข้าก๊วน'],
  ] as const)('removes the entire %s card when unavailable', (key, label) => {
    const result = html({ ...data, [key]: null });
    expect(result).not.toContain(label);
    expect(result.match(/data-card/g)).toHaveLength(7);
  });
  it('keeps real zero values distinct from missing permission', () => {
    const result = html({ ...data, unclosedSessionsCount: 0, joinRequestsPending: 0,
      outstanding: { amount: '0.00', debtors: 0 }, pendingSlips: { count: 0, oldestDays: null },
      netCashThisMonth: '0.00', creditOutstanding: '0.00' });
    expect(result.match(/data-card/g)).toHaveLength(8);
    expect(result).toContain('฿0.00');
    expect(result).not.toContain('เก่าสุด');
  });
});
