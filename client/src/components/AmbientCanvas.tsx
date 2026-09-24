import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Ambient } from '../three/ambient.ts';
import { usePrefersReducedMotion } from '../lib/hooks.ts';

const AmbientContext = createContext<Ambient | null>(null);

/** One WebGL canvas behind the whole app; screens tell it where the light comes from. */
export function AmbientProvider({ children }: { children: ReactNode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ambient, setAmbient] = useState<Ambient | null>(null);
  const reduce = usePrefersReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let a: Ambient | null = null;
    let cancelled = false;
    const onResize = () => a?.resize();
    // WebGL arrives after the first paint; until then the app is simply dark.
    void import('../three/ambient.ts').then(({ Ambient }) => {
      if (cancelled) return;
      try {
        a = new Ambient(canvas, reduce);
      } catch {
        return; // no WebGL
      }
      setAmbient(a);
      window.addEventListener('resize', onResize);
    });
    return () => {
      cancelled = true;
      window.removeEventListener('resize', onResize);
      a?.dispose();
      setAmbient(null);
    };
  }, [reduce]);

  return (
    <AmbientContext.Provider value={ambient}>
      <canvas ref={canvasRef} className="ambient" aria-hidden />
      {children}
    </AmbientContext.Provider>
  );
}

export function useAmbient(): Ambient | null {
  return useContext(AmbientContext);
}

/** Keeps the light source glued to an element as it moves and resizes. */
export function useAmbientRect(ref: React.RefObject<HTMLElement | null>, radius = 18, enabled = true) {
  const ambient = useAmbient();
  useEffect(() => {
    const el = ref.current;
    if (!ambient || !el || !enabled) return;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        ambient.setRect({ x: r.x, y: r.y, width: r.width, height: r.height }, radius);
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    // The mini player moves by transform; follow it while it does.
    const mo = new MutationObserver(update);
    mo.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [ambient, ref, radius, enabled]);
}
