import { animate, motion, useMotionValue, useTransform, type AnimationPlaybackControls } from 'motion/react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMediaQuery, usePrefersReducedMotion } from '../lib/hooks.ts';
import { bounceFor, project, rubberband, springs, VelocityTracker } from '../lib/physics.ts';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
}

/**
 * A bottom sheet you can grab at any moment — while it opens, while it closes,
 * mid-bounce — and it follows the finger from exactly where it is.
 * On tablets and desktops it becomes a centred form sheet.
 */
export function Sheet({ open, onClose, title, leading, trailing, children }: SheetProps) {
  const [mounted, setMounted] = useState(open);
  const formSheet = useMediaQuery('(min-width: 900px) and (min-height: 600px)');
  const reduce = usePrefersReducedMotion();
  const sheetRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();

  const y = useMotionValue(0);
  const presence = useMotionValue(0); // 0 hidden → 1 shown, for form sheet and reduced motion
  const heightRef = useRef(600);
  const anim = useRef<AnimationPlaybackControls | null>(null);
  const closing = useRef(false);

  const scrimOpacity = useTransform(() => {
    if (formSheet || reduce) return presence.get() * 0.5;
    const h = heightRef.current || 1;
    return Math.max(0, Math.min(0.5, 0.5 * (1 - y.get() / h)));
  });
  const formScale = useTransform(presence, [0, 1], [0.94, 1]);
  const formFilter = useTransform(presence, (p) => `blur(${(1 - p) * 8}px)`);

  if (open && !mounted) setMounted(true);

  const settle = useCallback(
    (to: 'open' | 'closed', velocity = 0) => {
      anim.current?.stop();
      closing.current = to === 'closed';
      const done = () => {
        if (to === 'closed') {
          setMounted(false);
          returnFocus.current?.focus?.();
        }
      };
      if (formSheet || reduce) {
        const a = animate(presence, to === 'open' ? 1 : 0, reduce ? { duration: 0.15, ease: 'linear' } : springs.sheet);
        anim.current = a;
        // `finished` also resolves when an animation is stopped; only the one still in charge may unmount.
        void a.finished.then(() => anim.current === a && done());
        return;
      }
      presence.set(1);
      const target = to === 'open' ? 0 : heightRef.current + 40;
      const a = animate(y, target, { ...springs.sheet, velocity, bounce: to === 'open' ? bounceFor(velocity) : 0 });
      anim.current = a;
      void a.finished.then(() => anim.current === a && done());
    },
    [formSheet, reduce, presence, y],
  );

  // Enter from wherever it currently is (offscreen on first open, mid-exit if reopened).
  useLayoutEffect(() => {
    if (!mounted) return;
    const el = sheetRef.current;
    if (el) heightRef.current = el.offsetHeight;
    if (open) {
      if (!closing.current && y.get() === 0 && presence.get() === 0 && !formSheet && !reduce) y.set(heightRef.current + 40);
      settle('open');
    } else if (!closing.current) settle('closed'); // a drag-dismiss already launched it with the finger's velocity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mounted]);

  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => {
      const first = sheetRef.current?.querySelector<HTMLElement>('[data-autofocus], input, textarea, button:not(.sheet-grabber)');
      first?.focus({ preventScroll: true });
    }, 60);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  // ── drag ──
  const drag = useRef<{ id: number; startY: number; y0: number; active: boolean } | null>(null);
  const tracker = useRef(new VelocityTracker());

  const onPointerDown = (e: React.PointerEvent) => {
    if (formSheet || reduce || e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, textarea') && !target.closest('.sheet-grabber')) return;
    anim.current?.stop(); // catch it mid-flight
    anim.current = null;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, startY: e.clientY, y0: y.get(), active: false };
    tracker.current.reset();
    tracker.current.add(0, e.clientY);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    tracker.current.add(0, e.clientY);
    let dy = e.clientY - d.startY;
    if (!d.active) {
      if (Math.abs(dy) < 10) return; // hysteresis: a tap is not a drag
      d.active = true;
      d.startY = e.clientY; // begin from here: no jump when the drag is recognised
      d.y0 = y.get();
      dy = 0;
    }
    const next = d.y0 + dy;
    y.set(next < 0 ? rubberband(next, heightRef.current) : next);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const v = tracker.current.get().y;
    if (!d.active) {
      // A caught sheet that was not dragged goes back where it was heading.
      settle(closing.current ? 'closed' : 'open');
      return;
    }
    const rest = y.get() + project(v);
    if (rest > heightRef.current * 0.5) {
      closing.current = true;
      onClose();
      settle('closed', v);
    } else settle('open', v);
  };

  if (!mounted) return null;

  const dragProps = {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
  };

  return createPortal(
    <>
      <motion.div className="scrim" style={{ opacity: scrimOpacity }} onClick={onClose} aria-hidden />
      <motion.div
        ref={sheetRef}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={
          formSheet || reduce
            ? { opacity: presence, scale: reduce ? 1 : formScale, filter: reduce ? undefined : formFilter }
            : { y }
        }
      >
        <div className="sheet-grabber" {...dragProps} aria-hidden />
        <div className="sheet-head" {...dragProps}>
          <div>{leading}</div>
          <h2 id={titleId}>{title}</h2>
          <div>{trailing}</div>
        </div>
        <div className="sheet-body">{children}</div>
      </motion.div>
    </>,
    document.body,
  );
}
