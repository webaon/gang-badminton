/** Test fixtures submit gang wall time, not the Node runner's local time.
 * Fixture gangs use Asia/Bangkok; keep CI (UTC) and local runs equivalent.
 * `now` makes calendar-boundary regression tests deterministic.
 */
export function localDateTime(hoursFromNow: number, now = Date.now()): string {
  const at = new Date(now + hoursFromNow * 60 * 60 * 1000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
