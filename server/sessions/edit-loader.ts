import 'server-only';

import { notFound } from 'next/navigation';
import { can } from '@/domain/permissions/can';
import { utcToZonedWallClock } from '@/domain/time/timezone';
import { requireUser } from '@/lib/supabase/auth';
import { supabaseServer } from '@/lib/supabase/server';
import { loadGangPermissionContext } from '@/server/permissions/gang-context';
import type { UpdateSessionInput } from '@/server/actions/sessions';

/** Read actual edit fields through RLS; never reconstruct court count from a default. */
export async function loadSessionEdit(gangId: string, sessionId: string) {
  const user = await requireUser(`/gangs/${gangId}/sessions/${sessionId}/edit`);
  const ctx = await loadGangPermissionContext(gangId, user.id);
  if (!can(ctx, 'session.update')) notFound();
  const supabase = await supabaseServer();
  const { data, error } = await supabase.from('sessions')
    .select('id, title, venue, starts_at, ends_at, status, court_count, max_players, allow_guests, gangs!inner(name, timezone)')
    .eq('gang_id', gangId).eq('id', sessionId).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  if (!data) notFound();
  const row = data as unknown as {
    id: string; title: string; venue: string | null; starts_at: string; ends_at: string;
    status: string; court_count: number; max_players: number; allow_guests: boolean;
    gangs: { name: string; timezone: string };
  };
  const initial: UpdateSessionInput = {
    title: row.title, venue: row.venue,
    startsAtLocal: utcToZonedWallClock(new Date(row.starts_at), row.gangs.timezone),
    endsAtLocal: utcToZonedWallClock(new Date(row.ends_at), row.gangs.timezone),
    courtCount: row.court_count, maxPlayers: row.max_players, allowGuests: row.allow_guests,
  };
  return { gangId, sessionId: row.id, gangName: row.gangs.name, timezone: row.gangs.timezone,
    status: row.status, canEdit: ['draft', 'open'].includes(row.status), initial };
}
