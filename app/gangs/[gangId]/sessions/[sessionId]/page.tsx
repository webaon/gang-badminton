import { SessionDetailPage } from '@/features/sessions/SessionDetailPage';

export const dynamic = 'force-dynamic';

export default async function SessionDetailRoute({
  params,
}: {
  params: Promise<{ gangId: string; sessionId: string }>;
}) {
  const { gangId, sessionId } = await params;
  return <SessionDetailPage gangId={gangId} sessionId={sessionId} />;
}
