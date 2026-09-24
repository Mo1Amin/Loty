import { useEffect, useState, useSyncExternalStore } from 'react';
import { client, type ClientState } from './room-client.ts';

export function useClient(): ClientState {
  return useSyncExternalStore(client.subscribe, client.getState);
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}

// ── Toasts ──────────────────────────────────────────────────────────────────

export interface Toast {
  id: number;
  text: string;
  from?: string;
  hue?: number;
  actions?: { label: string; onClick: () => void; primary?: boolean }[];
  /** ms; 0 keeps it until an action is taken */
  duration?: number;
}

let toasts: Toast[] = [];
let nextToast = 1;
const toastListeners = new Set<() => void>();
const emitToasts = () => toastListeners.forEach((fn) => fn());

export function toast(t: Omit<Toast, 'id'> | string): number {
  const item: Toast = typeof t === 'string' ? { id: nextToast++, text: t } : { ...t, id: nextToast++ };
  toasts = [...toasts.slice(-3), item];
  emitToasts();
  const duration = item.duration ?? 3_200;
  if (duration > 0) window.setTimeout(() => dismissToast(item.id), duration);
  return item.id;
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emitToasts();
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (fn) => {
      toastListeners.add(fn);
      return () => toastListeners.delete(fn);
    },
    () => toasts,
  );
}

// ── Preferences (per device, never important) ──────────────────────────────

export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`loty.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: unknown) {
  try {
    localStorage.setItem(`loty.${key}`, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

export function haptic(ms = 8) {
  // Android only; iOS Safari has no vibration API. Used for confirmations, never for decoration.
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* not allowed */
  }
}
