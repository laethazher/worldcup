import { toast } from './ui.js';

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'same-origin',
    ...options,
  });
  if (res.status === 401 && !location.pathname.includes('login')) {
    location.href = '/login.html';
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as any)?.error || 'حدث خطأ غير متوقع';
    toast(msg, 'err');
    throw new Error(msg);
  }
  return data as T;
}

export const get = <T = any>(p: string) => api<T>(p);
export const post = <T = any>(p: string, body?: unknown) =>
  api<T>(p, { method: 'POST', body: JSON.stringify(body ?? {}) });
export const patch = <T = any>(p: string, body?: unknown) =>
  api<T>(p, { method: 'PATCH', body: JSON.stringify(body ?? {}) });
