import { parseSessionTab } from '@/domain/sessions/member-view';
import { SessionsListPage } from '@/features/sessions/SessionsListPage';

export const dynamic = 'force-dynamic';

export default async function SessionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ gangId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { gangId } = await params;
  const { tab } = await searchParams;
  return <SessionsListPage gangId={gangId} tab={parseSessionTab(tab)} />;
}
