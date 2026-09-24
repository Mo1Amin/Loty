import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { Color } from 'three';
import { client } from '../lib/room-client.ts';
import { readPref, usePrefersReducedMotion, useClient, writePref } from '../lib/hooks.ts';
import { navigate } from '../lib/router.ts';
import { useAmbient, useAmbientRect } from './AmbientCanvas.tsx';
import { Icon } from './Icon.tsx';
import { Row } from './ui.tsx';
import type { EdgeColors } from '../three/ambient.ts';

// Four "scenes" the hero screen cycles through, as if a film were playing on it.
const SCENES: [string, string, string, string][] = [
  ['#1b3a6b', '#e07a2e', '#20181a', '#2b6f8f'], // dusk street
  ['#3b1d5c', '#a33a7a', '#110a1c', '#2c3f9e'], // neon night
  ['#274d2f', '#b8a34a', '#0e1a10', '#3d7a52'], // forest
  ['#5c1f1f', '#d0643a', '#1a0d0a', '#8a3a28'], // fire
];
const toEdges = (s: string[]): EdgeColors => s.map((h) => new Color(h)) as EdgeColors;

export function Landing() {
  const [name, setName] = useState(() => readPref('name', ''));
  const [code, setCode] = useState('');
  const [mode, setMode] = useState<'start' | 'code'>('start');
  const [error, setError] = useState('');
  const { phase, connected } = useClient();
  const busy = phase.name === 'joining';
  const screenRef = useRef<HTMLDivElement>(null);
  const ambient = useAmbient();
  const reduce = usePrefersReducedMotion();

  useAmbientRect(screenRef, 18);
  useEffect(() => {
    if (!ambient) return;
    let i = 0;
    ambient.setColors(toEdges(SCENES[0]!), 0.7);
    if (reduce) return;
    const t = window.setInterval(() => {
      i = (i + 1) % SCENES.length;
      ambient.setColors(toEdges(SCENES[i]!), 0.7);
    }, 4_500);
    return () => {
      window.clearInterval(t);
      ambient.setColors(null);
    };
  }, [ambient, reduce]);

  const saveName = () => {
    const n = name.trim();
    writePref('name', n);
    return n;
  };

  const start = async () => {
    setError('');
    const res = await client.create(saveName());
    if (!res.ok) setError(res.error);
    // App moves the address to /r/CODE once the room state arrives.
  };

  const join = async () => {
    setError('');
    const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean.length !== 6) {
      setError('الكود ٦ حروف وأرقام، زي K7M2QX.');
      return;
    }
    saveName();
    navigate(`/r/${clean}`);
  };

  return (
    <main className="landing">
      <div className="landing-main">
        <motion.div
          ref={screenRef}
          className="hero-screen"
          initial={reduce ? false : { opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: 'spring', bounce: 0, visualDuration: 0.6 }}
        >
          <div className="wordmark">
            <img src="/icon.svg" alt="" />
            <h1>Loty</h1>
          </div>
        </motion.div>
        <p className="tagline">اتفرجوا سوا، في نفس الثانية.</p>

        <form
          className="landing-form"
          onSubmit={(e) => {
            e.preventDefault();
            void (mode === 'start' ? start() : join());
          }}
        >
          <label className="visually-hidden" htmlFor="name">اسمك</label>
          <input
            id="name"
            className="field"
            placeholder="اسمك (هيظهر للي معاك)"
            autoComplete="nickname"
            maxLength={24}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {mode === 'start' ? (
            <>
              <button className="btn btn-filled btn-wide" type="submit" disabled={busy || !connected}>
                {connected ? 'ابدأ غرفة' : 'بيتصل…'}
              </button>
              <button className="btn btn-gray btn-wide" type="button" onClick={() => setMode('code')}>
                معايا كود
              </button>
            </>
          ) : (
            <>
              <div className="code-row">
                <label className="visually-hidden" htmlFor="code">كود الغرفة</label>
                <input
                  id="code"
                  className="field"
                  placeholder="K7M2QX"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={7}
                  value={code}
                  autoFocus
                  onChange={(e) => setCode(e.target.value)}
                />
              </div>
              <button className="btn btn-filled btn-wide" type="submit" disabled={busy}>
                ادخل الغرفة
              </button>
              <button className="btn btn-plain" type="button" onClick={() => setMode('start')}>
                لأ، هبدأ غرفة جديدة
              </button>
            </>
          )}
          <p className="form-error" role="alert">{error}</p>
        </form>
      </div>

      <section className="landing-caps" aria-label="تقدروا تتفرجوا على إيه">
        <div className="group">
          <Row icon={<Icon name="youtube" size="sm" />} iconBg="#ff3b30" title="يوتيوب والبلاي ليستات" sub="الليستة كلها بتتحول لقايمة واحدة للغرفة" />
          <Row icon={<Icon name="broadcast" size="sm" />} iconBg="#ff9f0a" title="بث من شاشتك" sub="كورس أو موقع محتاج حساب؟ واحد يفتحه والباقي يتفرج" />
          <Row icon={<Icon name="film" size="sm" />} iconBg="#5e5ce6" title="Vimeo وروابط مباشرة" sub="MP4 و WebM و HLS" />
          <Row icon={<Icon name="file" size="sm" />} iconBg="#30b0c7" title="ملف من جهازك" sub="كل واحد يفتح نسخته، أو ابثّه للباقي" />
          <Row icon={<Icon name="mic" size="sm" />} iconBg="#30d158" title="كلام بالصوت" sub="صوت الفيديو بيوطى لوحده وانتوا بتتكلموا" />
        </div>
      </section>
      <p className="landing-foot">مفيش حسابات ولا تسجيل. الغرفة بتختفي لما آخر واحد يخرج.</p>
    </main>
  );
}
