import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const read = (path: string) => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('dashboard UI boundaries', () => {
  it.each(['DashboardPage', 'DashboardSummary', 'DashboardDetails'])('%s keeps money/permissions/server internals outside UI', name => {
    const source = read(`features/dashboard/${name}.tsx`);
    expect(source).not.toMatch(/domain\/billing|role\s*===|\.payload\b|supabaseServer\(|supabaseBrowser\(|\.from\(|parseFloat\(|Number\(|style=\{|xstyle=|<div\b|<span\b|กำไร/);
    expect(source).not.toMatch(/idKey=\{\(|renderCell:/);
  });
  it('uses the authoritative loader, translated errors and a thin authenticated route', () => {
    const page = read('features/dashboard/DashboardPage.tsx');
    expect(page).toContain('await requireUser(');
    expect(page).toContain('await dashboardOverview(gangId)');
    expect(page).toContain('notFound()');
    expect(page).toContain('actionError(result.error)');
    expect(read('app/gangs/[gangId]/dashboard/page.tsx')).toContain("export { default } from '@/features/dashboard/DashboardPage'");
  });
});
