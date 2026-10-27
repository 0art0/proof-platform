const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const two = (value: number) => String(value).padStart(2, "0");

/**
 * A recorded ISO timestamp for reading ("29 Sep 2026, 12:00:00 UTC"). It is always rendered in UTC
 * with fixed words, so the server and the browser produce the same text. A value that is not a
 * date is returned unchanged.
 */
export function formatRecordedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  const time = `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())}`;
  return `${day}, ${time} UTC`;
}
