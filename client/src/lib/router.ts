import { useSyncExternalStore } from 'react';

// Two routes do not need a router: "/" and "/r/CODE".

const listeners = new Set<() => void>();
window.addEventListener('popstate', () => listeners.forEach((fn) => fn()));

export function navigate(path: string, replace = false) {
  if (location.pathname === path) return;
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  listeners.forEach((fn) => fn());
}

export function usePath(): string {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => location.pathname,
  );
}

export function roomCodeFrom(path: string): string | null {
  const m = /^\/r\/([A-Za-z0-9]{6})\/?$/.exec(path);
  return m ? m[1]!.toUpperCase() : null;
}
