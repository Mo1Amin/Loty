import { useState } from 'react';
import { client } from '../lib/room-client.ts';
import { readPref, useClient, writePref } from '../lib/hooks.ts';
import { navigate } from '../lib/router.ts';

export function JoinGate({ code }: { code: string }) {
  const { phase, connected } = useClient();
  const [name, setName] = useState(() => readPref('name', ''));
  const [error, setError] = useState('');
  const pretty = `${code.slice(0, 3)} ${code.slice(3)}`;

  const home = () => {
    client.reset();
    navigate('/');
  };

  // Reloaded inside a room: the client resumes the seat by itself as soon as it connects.
  if (client.hasSessionFor(code) && phase.name !== 'gone') {
    return (
      <Gate>
        <div className="spinner" role="status" aria-label="بيرجّعك للغرفة" />
        <h2>بيرجّعك للغرفة</h2>
        <p>{connected ? 'ثانية واحدة…' : 'مستني الإنترنت يرجع…'}</p>
      </Gate>
    );
  }

  if (phase.name === 'knocking') {
    return (
      <Gate>
        <div className="spinner" role="status" aria-label="مستني" />
        <h2>خبّطت على الباب</h2>
        <p>الغرفة مقفولة. أول ما المضيف يوافق هتدخل على طول.</p>
        <button className="btn btn-gray btn-wide" onClick={() => { client.leave(); navigate('/'); }}>
          إلغاء
        </button>
      </Gate>
    );
  }

  if (phase.name === 'gone') {
    return (
      <Gate>
        <h2>مش هتقدر تدخل دلوقتي</h2>
        <p>{phase.reason}</p>
        <button className="btn btn-filled btn-wide" onClick={home}>
          الصفحة الرئيسية
        </button>
      </Gate>
    );
  }

  const join = async () => {
    setError('');
    writePref('name', name.trim());
    const res = await client.join(code, name.trim());
    if (!res.ok) setError(res.error);
  };

  return (
    <Gate>
      <h2>انت معزوم تتفرج</h2>
      <p>
        الغرفة <span className="gate-code">{pretty}</span>
      </p>
      <form
        style={{ display: 'grid', gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          void join();
        }}
      >
        <label className="visually-hidden" htmlFor="join-name">اسمك</label>
        <input
          id="join-name"
          className="field"
          placeholder="اسمك (هيظهر للي معاك)"
          autoComplete="nickname"
          maxLength={24}
          value={name}
          autoFocus={!name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="btn btn-filled btn-wide" type="submit" disabled={!connected || phase.name === 'joining'}>
          {connected ? 'ادخل' : 'بيتصل…'}
        </button>
        <p className="form-error" role="alert">{error}</p>
      </form>
      <button className="btn btn-plain" onClick={home}>
        ابدأ غرفة بتاعتك بدل كده
      </button>
    </Gate>
  );
}

function Gate({ children }: { children: React.ReactNode }) {
  return (
    <main className="gate">
      <div className="gate-card">{children}</div>
    </main>
  );
}
