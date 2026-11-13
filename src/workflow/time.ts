/**
 * Time helpers for long-running workflows: wait durations ("90m", "2 hours", "3d"), the next
 * occurrence of a local time of day in a time zone, and the target of a Wait step.
 */

const UNIT: Record<string, number> = { s: 1000, sec: 1000, second: 1000, m: 60_000, min: 60_000, minute: 60_000, h: 3_600_000, hr: 3_600_000, hour: 3_600_000, d: 86_400_000, day: 86_400_000, w: 604_800_000, week: 604_800_000 };

/** "90m", "2 hours", "1.5h", "3 days", or a bare number of minutes. Null if not a duration. */
export function parseWaitDuration(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v * 60_000;
  if (typeof v !== "string") return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+?)s?\s*$/i.exec(v);
  if (!m) return /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) * 60_000 : null;
  const unit = UNIT[m[2].toLowerCase()];
  return unit ? Number(m[1]) * unit : null;
}

/** Milliseconds to add to UTC to get local wall time in `tz` at instant `d`. */
function tzOffset(d: Date, tz: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d).map((p) => [p.type, p.value]));
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return local - Math.floor(d.getTime() / 1000) * 1000;
}

/** Next instant (after `now`) when the wall clock in `tz` reads HH:MM, optionally only on weekdays. */
export function nextLocalTime(hhmm: string, tz: string, now = new Date(), weekdaysOnly = false): Date {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`"${hhmm}" isn't a time of day (use HH:MM, e.g. 09:30)`);
  for (let i = 0; i < 9; i++) {
    const dayStart = new Date(now.getTime() + i * 86_400_000 + tzOffset(now, tz));
    const guess = Date.UTC(dayStart.getUTCFullYear(), dayStart.getUTCMonth(), dayStart.getUTCDate(), Number(m[1]), Number(m[2]));
    // Correct for the offset on that day (DST changes).
    const at = new Date(guess - tzOffset(new Date(guess), tz));
    const dow = new Date(at.getTime() + tzOffset(at, tz)).getUTCDay();
    if (at.getTime() > now.getTime() && (!weekdaysOnly || (dow !== 0 && dow !== 6))) return at;
  }
  throw new Error("Couldn't find the next matching time");
}

export const MAX_WAIT_MS = 90 * 86_400_000;

/**
 * When a Wait step should resume. Config: `duration` ("2h"), or `until` (a date or an
 * expression that evaluates to one), or `at` ("09:30", with `timezone` and `weekdays`).
 */
export function waitTarget(cfg: Record<string, unknown>, until: unknown, now = new Date()): Date {
  let at: Date;
  if (cfg.duration !== undefined && cfg.duration !== "") {
    const ms = parseWaitDuration(cfg.duration);
    if (ms === null) throw new Error(`"${String(cfg.duration)}" isn't a duration (try 30m, 2h or 3 days)`);
    at = new Date(now.getTime() + ms);
  } else if (until !== undefined && until !== null && until !== "") {
    at = until instanceof Date ? until : new Date(typeof until === "number" ? until : String(until));
    if (Number.isNaN(at.getTime())) throw new Error(`"${String(until)}" isn't a date`);
  } else if (typeof cfg.at === "string" && cfg.at) {
    at = nextLocalTime(cfg.at, String(cfg.timezone ?? "Asia/Kolkata"), now, cfg.weekdays === true);
  } else throw new Error("Set how long to wait: a duration, a date, or a time of day");
  if (at.getTime() - now.getTime() > MAX_WAIT_MS) throw new Error("Waits are limited to 90 days");
  return at;
}
