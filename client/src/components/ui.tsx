import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { dismissToast, usePrefersReducedMotion, useToasts } from '../lib/hooks.ts';
import { springs } from '../lib/physics.ts';

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; count?: number }[];
  onChange: (v: T) => void;
  label: string;
}) {
  const reduce = usePrefersReducedMotion();
  return (
    <div className="segmented" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === value}
          className="segment"
          // Select on press, not release: the thumb starts moving under the finger.
          onPointerDown={(e) => {
            if (e.button === 0) onChange(o.value);
          }}
          onClick={() => onChange(o.value)}
        >
          {o.value === value && (
            <motion.span layoutId={`seg-${label}`} className="segment-thumb" transition={reduce ? { duration: 0 } : springs.snappy} />
          )}
          {o.label}
          {o.count ? <span className="count">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  const reduce = usePrefersReducedMotion();
  // Flip under the finger now; the server's answer arrives a round trip later.
  // If it never agrees (refused, offline), fall back to what is true.
  const [local, setLocal] = useState(checked);
  const revert = useRef(0);
  useEffect(() => {
    setLocal(checked);
    window.clearTimeout(revert.current);
  }, [checked]);
  useEffect(() => () => window.clearTimeout(revert.current), []);
  return (
    <span className="switch">
      <input
        type="checkbox"
        role="switch"
        checked={local}
        aria-label={label}
        onChange={(e) => {
          const next = e.target.checked;
          setLocal(next);
          onChange(next);
          window.clearTimeout(revert.current);
          revert.current = window.setTimeout(() => setLocal(checked), 2_000);
        }}
      />
      <span className="switch-track" />
      <motion.span
        className="switch-thumb"
        initial={false}
        animate={{ x: local ? -20 : 0 }} // RTL: "on" slides to the left edge
        transition={reduce ? { duration: 0 } : springs.snappy}
      />
    </span>
  );
}

export function Avatar({ name, hue, size = 32, speaking, offline }: { name: string; hue: number; size?: number; speaking?: boolean; offline?: boolean }) {
  const initial = [...name.trim()][0]?.toUpperCase() ?? '؟';
  return (
    <span
      className={`avatar${speaking ? ' speaking' : ''}${offline ? ' offline' : ''}`}
      style={{ ['--hue' as string]: hue, ['--size' as string]: `${size}px` }}
      aria-hidden
    >
      {initial}
    </span>
  );
}

export function Row({
  icon,
  iconBg,
  title,
  sub,
  end,
  onClick,
  as = 'div',
  disabled,
}: {
  icon?: ReactNode;
  iconBg?: string;
  title: ReactNode;
  sub?: ReactNode;
  end?: ReactNode;
  onClick?: () => void;
  as?: 'div' | 'button' | 'label';
  disabled?: boolean;
}) {
  const Tag = as;
  return (
    <Tag className={`row${icon ? '' : ' no-icon'}`} onClick={onClick} {...(as === 'button' ? { type: 'button' as const, disabled } : {})}>
      {icon && (
        <span className="row-icon" style={{ background: iconBg }}>
          {icon}
        </span>
      )}
      <span className="row-text">
        <span className="row-title">{title}</span>
        {sub && <span className="row-sub" style={{ display: 'block' }}>{sub}</span>}
      </span>
      {end && <span className="row-end">{end}</span>}
    </Tag>
  );
}

export function Toasts() {
  const toasts = useToasts();
  const reduce = usePrefersReducedMotion();
  return (
    <div className="toasts" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            className="toast"
            // Materialize: come into focus rather than slide in from nowhere.
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.9, filter: 'blur(8px)', y: -8 }}
            animate={{ opacity: 1, scale: 1, filter: 'blur(0px)', y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94, filter: 'blur(6px)' }}
            transition={reduce ? { duration: 0.15 } : springs.snappy}
            onClick={() => !t.actions && dismissToast(t.id)}
          >
            {t.hue !== undefined && t.from && <Avatar name={t.from} hue={t.hue} size={26} />}
            <span className="grow">
              {t.from && <span className="from">{t.from}: </span>}
              {t.text}
            </span>
            {t.actions && (
              <span className="toast-actions">
                {t.actions.map((a) => (
                  <button
                    key={a.label}
                    className={`btn btn-small ${a.primary ? 'btn-filled' : 'btn-gray'}`}
                    onClick={() => {
                      a.onClick();
                      dismissToast(t.id);
                    }}
                  >
                    {a.label}
                  </button>
                ))}
              </span>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
