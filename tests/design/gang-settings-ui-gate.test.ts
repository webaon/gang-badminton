import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8');
const source = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const ui = [
  'features/gangs/GangSettingsPage.tsx', 'features/gangs/GangMembersPage.tsx',
  'features/gangs/GangSettingsForm.tsx', 'features/gangs/MembersPanel.tsx',
  'features/gangs/PricingAndSkills.tsx', 'features/billing/MonthlyPlanForm.tsx',
  'features/line/LineSettingsPanel.tsx',
];

describe('WO-6.6a settings/member UI boundaries', () => {
  it.each(ui)('%s uses Astryx and never calculates money or derives permissions from roles', file => {
    const text = source(file);
    expect(text).not.toMatch(/from\s+['"][^'"]*domain\/billing/);
    expect(text).not.toMatch(/\brole\s*={2,3}|\brole\s*!={1,2}/);
    expect(text).not.toMatch(/<div\b|<span\b|\bstyle=\{|\bxstyle=|stylex\.create/);
    expect(text).not.toMatch(/(?:Number|parseFloat)\(\s*(?:amount|courtFee|shuttlePrice|monthlyFee|outstandingAmount|creditBalance)/);
    expect(text).not.toMatch(/from\s+['"](?:@radix-ui|@mui|@chakra-ui)/);
  });

  it.each(['members', 'settings'])('%s route is thin; gate stays in server-only loader using the full permission context', route => {
    const page = source(`app/gangs/[gangId]/${route}/page.tsx`);
    expect(page).toContain('export { default }');
    expect(page).not.toMatch(/supabase|\.from\(|can\(/);
    const loader = source(`server/gangs/${route}-loader.ts`);
    expect(loader).toContain("import 'server-only'");
    expect(loader).toContain('loadGangPermissionContext(gangId, user.id)');
    expect(loader).toMatch(/can\(ctx,/);
    expect(loader).toContain('if (!gang) notFound()');
    expect(loader).toContain('if (!ctx.role) notFound()');
    expect(loader).not.toContain(".select('role')");
  });

  it('read data sources are the existing page queries, not finance/profile enrichment', () => {
    const tables = (text: string) => [...text.matchAll(/\.from\('([^']+)'\)/g)].map(match => match[1]);
    expect(tables(source('server/gangs/settings-loader.ts'))).toEqual(['gangs', 'gang_pricing_plans', 'gang_pricing_plans', 'gang_skill_levels']);
    expect(tables(source('server/gangs/members-loader.ts'))).toEqual(['gangs', 'gang_members']);
    expect(source('server/gangs/settings-loader.ts')).toContain(".in('type', SESSION_PRICING_TYPES)");
    expect(source('server/gangs/members-loader.ts')).toContain('profiles!gang_members_user_id_fkey!inner(display_name)');
  });
});
