import { getSetting, setSetting } from './db';

const DAY = 86_400_000;

/**
 * The app clock. It is the real clock plus an offset, so a demo can move time forward
 * and watch receipts expire without waiting sixty days.
 */
export function now(): Date {
  return new Date(Date.now() + getSetting<number>('clock_offset_ms', 0));
}

export function nowIso(): string {
  return now().toISOString();
}

export function clockOffsetDays(): number {
  return Math.round(getSetting<number>('clock_offset_ms', 0) / DAY);
}

export function advanceClock(days: number): void {
  setSetting('clock_offset_ms', getSetting<number>('clock_offset_ms', 0) + days * DAY);
}

export function daysFrom(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY);
}

export { DAY };
