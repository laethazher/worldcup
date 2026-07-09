const TZ = 'Asia/Baghdad';

export function kickoffLabel(utc: string): string {
  const d = new Date(utc);
  const date = new Intl.DateTimeFormat('ar-IQ', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(d);
  const time = new Intl.DateTimeFormat('ar-IQ', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(d);
  return `${date} — ${time} بتوقيت بغداد`;
}

export function shortTime(utc: string): string {
  return new Intl.DateTimeFormat('ar-IQ', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(utc));
}

export function dateTimeFull(utc: string): string {
  return new Intl.DateTimeFormat('ar-IQ', {
    timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(utc));
}

export interface CDParts { d: number; h: number; m: number; s: number; done: boolean; }
export function countdownParts(utc: string): CDParts {
  const diff = new Date(utc).getTime() - Date.now();
  if (diff <= 0) return { d: 0, h: 0, m: 0, s: 0, done: true };
  const s = Math.floor(diff / 1000);
  return { d: Math.floor(s / 86400), h: Math.floor(s / 3600) % 24, m: Math.floor(s / 60) % 60, s: s % 60, done: false };
}

export const pad = (n: number) => String(n).padStart(2, '0');

export function initials(name: string): string {
  const parts = (name || '').trim().split(/\s+/);
  return (parts[0]?.[0] || '') + (parts[1]?.[0] || '');
}

export const nf = new Intl.NumberFormat('ar-IQ');