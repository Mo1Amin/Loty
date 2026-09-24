import { animate, motion, useMotionValue, type AnimationPlaybackControls } from 'motion/react';
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { PlaybackState, QueueItem } from '../../../shared/protocol.ts';
import type { StageStatus, SyncController } from '../player/controller.ts';
import { usePrefersReducedMotion } from '../lib/hooks.ts';
import { bounceFor, nearest, project, rubberband, springs, VelocityTracker } from '../lib/physics.ts';
import { Icon } from './Icon.tsx';

export interface StageHandle {
  media: HTMLDivElement;
  reactions: HTMLCanvasElement;
  element: HTMLDivElement;
}

interface StageProps {
  controller: SyncController | null;
  item: QueueItem | null;
  playback: PlaybackState | null;
  mini: boolean;
  onExitMini: () => void;
  onAdd: () => void;
  onBroadcast: () => void;
  onSkip: () => void;
  canControl: boolean;
}

const idleStatus: StageStatus = { loading: false, error: null, needsTap: false, needsFile: null, waitingForStream: false, sync: 'idle', drift: 0 };

export const Stage = forwardRef<StageHandle, StageProps>(function Stage(props, ref) {
  const { controller, item, playback, mini, onExitMini, onAdd, onBroadcast, onSkip, canControl } = props;
  const slotRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLDivElement>(null);
  const reactRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const reduce = usePrefersReducedMotion();

  useImperativeHandle(ref, () => ({ media: mediaRef.current!, reactions: reactRef.current!, element: stageRef.current! }), []);

  const status = useSyncExternalStore(
    (fn) => controller?.subscribe(fn) ?? (() => {}),
    () => controller?.getStatus() ?? idleStatus,
  );

  // ── mini player geometry ──
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const scale = useMotionValue(1);
  const anim = useRef<AnimationPlaybackControls[]>([]);
  const corner = useRef<'bl' | 'br' | 'tl' | 'tr'>('br');
  const stop = () => {
    anim.current.forEach((a) => a.stop());
    anim.current = [];
  };

  const corners = () => {
    const el = stageRef.current!;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const m = 12;
    const top = m + 56; // below the top bar
    const bottom = vh - h - m - 72; // above the composer
    return [
      { id: 'tl' as const, x: m, y: top },
      { id: 'tr' as const, x: vw - w - m, y: top },
      { id: 'bl' as const, x: m, y: Math.max(top, bottom) },
      { id: 'br' as const, x: vw - w - m, y: Math.max(top, bottom) },
    ];
  };

  // Enter and leave along the same path: from the slot to a corner and back (FLIP).
  const wasMini = useRef(false);
  useLayoutEffect(() => {
    const el = stageRef.current;
    const slot = slotRef.current;
    if (!el || !slot || wasMini.current === mini) return;
    wasMini.current = mini;
    stop();
    const slotRect = slot.getBoundingClientRect();
    if (mini) {
      const miniWidth = el.offsetWidth; // the class already applied the mini size
      const target = corners().find((c) => c.id === corner.current)!;
      if (reduce) {
        x.set(target.x);
        y.set(target.y);
        scale.set(1);
        return;
      }
      x.set(slotRect.x);
      y.set(slotRect.y);
      scale.set(slotRect.width / miniWidth);
      anim.current = [animate(x, target.x, springs.move), animate(y, target.y, springs.move), animate(scale, 1, springs.move)];
    } else {
      // Leaving: we are back in the slot's layout; start from where the mini was and settle into place.
      const from = { x: x.get(), y: y.get() };
      if (reduce) {
        x.set(0);
        y.set(0);
        scale.set(1);
        return;
      }
      const miniW = Math.min(window.innerWidth * 0.46, 260);
      x.set(from.x - slotRect.x);
      y.set(from.y - slotRect.y);
      scale.set(miniW / slotRect.width);
      anim.current = [animate(x, 0, springs.move), animate(y, 0, springs.move), animate(scale, 1, springs.move)];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mini]);

  useEffect(() => {
    if (!mini) return;
    const onResize = () => {
      const t = corners().find((c) => c.id === corner.current)!;
      x.set(t.x);
      y.set(t.y);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mini]);

  const drag = useRef<{ id: number; ox: number; oy: number; sx: number; sy: number; moved: boolean } | null>(null);
  const tracker = useRef(new VelocityTracker());

  const onGripDown = (e: React.PointerEvent) => {
    stop(); // grab it mid-flight
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, ox: e.clientX - x.get(), oy: e.clientY - y.get(), sx: e.clientX, sy: e.clientY, moved: false };
    tracker.current.reset();
    tracker.current.add(e.clientX, e.clientY);
  };
  const onGripMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    tracker.current.add(e.clientX, e.clientY);
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 8) return;
    d.moved = true;
    const el = stageRef.current!;
    const maxX = window.innerWidth - el.offsetWidth;
    const maxY = window.innerHeight - el.offsetHeight;
    // 1:1 under the finger, keeping the grab offset; rubber-band past the screen edges.
    const band = (v: number, max: number, dim: number) => (v < 0 ? rubberband(v, dim) : v > max ? max + rubberband(v - max, dim) : v);
    x.set(band(e.clientX - d.ox, maxX, window.innerWidth));
    y.set(band(e.clientY - d.oy, maxY, window.innerHeight));
  };
  const onGripUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.moved) {
      onExitMini();
      return;
    }
    const v = tracker.current.get();
    // Where the throw would land, then the corner nearest to that — not to the release point.
    const target = nearest(corners(), x.get() + project(v.x), y.get() + project(v.y));
    corner.current = target.id;
    const bounce = bounceFor(Math.hypot(v.x, v.y));
    anim.current = [
      animate(x, target.x, { ...springs.move, velocity: v.x, bounce }),
      animate(y, target.y, { ...springs.move, velocity: v.y, bounce }),
    ];
  };

  const isBroadcast = item?.source.kind === 'broadcast';
  const openUrl = status.error?.openUrl;

  return (
    <div className="stage-slot" ref={slotRef}>
      <motion.div
        ref={stageRef}
        className={`stage${mini ? ' mini' : ''}${item ? '' : ' stage-empty'}`}
        style={{ x, y, scale, transformOrigin: '0 0' }}
      >
        <div className="stage-media" ref={mediaRef} />
        <canvas className="stage-reactions" ref={reactRef} aria-hidden />

        {!item && (
          <div className="stage-overlay stage-empty">
            <div className="panel">
              <Icon name="film" className="glyph" />
              <h3>مفيش حاجة شغّالة</h3>
              <p>حط لينك يوتيوب أو بلاي ليست، أو ابث من شاشتك.</p>
              <div className="actions">
                <button className="btn btn-filled btn-small" onClick={onAdd}>
                  <Icon name="plus" size="sm" /> إضافة
                </button>
              </div>
            </div>
          </div>
        )}

        {item && status.loading && (
          <div className="stage-overlay clear">
            <div className="spinner" role="status" aria-label="بيحمّل" />
          </div>
        )}

        {item && status.error && (
          <div className="stage-overlay">
            <div className="panel">
              <h3>الفيديو ده مش هيشتغل هنا</h3>
              <p>{status.error.message}</p>
              {status.error.embedBlocked && <p>الحل: واحد فيكم يفتحه في تاب ويبثّه من Loty، والباقي يتفرج.</p>}
              <div className="actions">
                {status.error.embedBlocked && (
                  <button className="btn btn-filled btn-small" onClick={onBroadcast}>
                    <Icon name="broadcast" size="sm" /> ابث من شاشتك
                  </button>
                )}
                {openUrl && (
                  <a className="btn btn-gray btn-small" href={openUrl} target="_blank" rel="noopener noreferrer">
                    افتحه في تاب
                  </a>
                )}
                {canControl && (
                  <button className="btn btn-gray btn-small" onClick={onSkip}>
                    تخطّى
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {item && status.needsFile && (
          <div className="stage-overlay">
            <div className="panel">
              <Icon name="file" className="glyph" />
              <h3>افتح نسختك من الملف</h3>
              <p>
                الباقي بيتفرج على <bdi>{status.needsFile.name}</bdi>. اختار نفس الملف من جهازك والتشغيل هيبقى متزامن.
              </p>
              <div className="actions">
                <button className="btn btn-filled btn-small" onClick={() => fileRef.current?.click()}>
                  اختار الملف
                </button>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="video/*,audio/*"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) controller?.openFile(f);
                  e.target.value = '';
                }}
              />
            </div>
          </div>
        )}

        {item && status.waitingForStream && (
          <div className="stage-overlay">
            <div className="panel">
              <div className="spinner" role="status" aria-label="بيوصل" />
              <h3>البث بيوصل</h3>
              <p>لو طوّل أكتر من ١٠ ثواني، غالباً الشبكة عندكم محتاجة سيرفر TURN. شوف الإعدادات.</p>
            </div>
          </div>
        )}

        {item && status.needsTap && !status.error && (
          <button className="tap-chip" onClick={() => void controller?.unlock()}>
            <Icon name="speakerOff" size="sm" /> دوس عشان الصوت
          </button>
        )}

        {playback?.holdFor && !isBroadcast && (
          <div className="hold-chip" role="status">
            <span className="spinner" style={{ width: 14, height: 14, margin: 0, borderWidth: 2 }} />
            مستنيين التحميل عند <bdi>{playback.holdFor}</bdi>
          </div>
        )}

        <div
          className="pip-grip"
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripUp}
          aria-label="المشغّل الصغير: اسحبه لأي ركن، أو دوس عليه يرجع"
          role="button"
        />
      </motion.div>
    </div>
  );
});
