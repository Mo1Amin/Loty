import { useEffect, useState } from 'react';
import type { RoomSnapshot } from '../../../shared/protocol.ts';
import { client } from '../lib/room-client.ts';
import { haptic, toast, writePref } from '../lib/hooks.ts';
import { Icon } from './Icon.tsx';
import { Sheet } from './Sheet.tsx';
import { Row, Segmented, Switch } from './ui.tsx';

export function inviteLink(code: string) {
  return `${location.origin}/r/${code}`;
}

export function InviteSheet({ open, onClose, code }: { open: boolean; onClose: () => void; code: string }) {
  const [qr, setQr] = useState('');
  const link = inviteLink(code);

  useEffect(() => {
    if (!open) return;
    void import('qrcode').then(({ default: QRCode }) => QRCode.toDataURL(link, { margin: 0, width: 344, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } })).then(setQr);
  }, [open, link]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      haptic();
      toast('اتنسخ اللينك.');
    } catch {
      toast('انسخ اللينك بإيدك من فوق.');
    }
  };

  const share = async () => {
    try {
      await navigator.share({ title: 'Loty', text: 'تعالى نتفرج سوا', url: link });
    } catch {
      /* dismissed */
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="ادعي حد"
      trailing={
        <button className="btn btn-plain" onClick={onClose}>
          تم
        </button>
      }
    >
      <div className="qr">{qr && <img src={qr} alt={`QR للينك ${link}`} />}</div>
      <p className="big-code" aria-label={`الكود ${code.split('').join(' ')}`}>
        {code.slice(0, 3)} {code.slice(3)}
      </p>
      <p className="big-code-note">صوّر الكود بكاميرا الموبايل، أو اكتب الكود في Loty.</p>
      <div className="group">
        <Row as="button" onClick={copy} icon={<Icon name="copy" size="sm" />} iconBg="var(--tint)" title="انسخ اللينك" sub={<span className="link-box">{link}</span>} />
        {'share' in navigator && <Row as="button" onClick={share} icon={<Icon name="share" size="sm" />} iconBg="#5e5ce6" title="شارك" />}
        <Row
          as="button"
          onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent(`تعالى نتفرج سوا على Loty:\n${link}`)}`, '_blank', 'noopener')}
          icon={<Icon name="chat" size="sm" />}
          iconBg="#25d366"
          title="ابعته على واتساب"
        />
      </div>
    </Sheet>
  );
}

export function SettingsSheet({
  open,
  onClose,
  room,
  isHost,
  duck,
  onDuck,
}: {
  open: boolean;
  onClose: () => void;
  room: RoomSnapshot;
  isHost: boolean;
  duck: boolean;
  onDuck: (v: boolean) => void;
}) {
  const me = client.me;
  const [name, setName] = useState(me?.name ?? '');
  useEffect(() => {
    if (open) setName(client.me?.name ?? '');
  }, [open]);

  const set = async (patch: Parameters<typeof client.settings>[0]) => {
    const res = await client.settings(patch);
    if (!res.ok) toast(res.error);
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="الغرفة"
      trailing={
        <button className="btn btn-plain" onClick={onClose}>
          تم
        </button>
      }
    >
      <h3 className="group-title">مين يتحكم</h3>
      <Segmented
        label="التحكم"
        value={room.settings.control}
        onChange={(v) => (isHost ? void set({ control: v }) : toast('المضيف بس اللي يغيّر ده.'))}
        options={[
          { value: 'everyone', label: 'الكل' },
          { value: 'host', label: 'المضيف بس' },
        ]}
      />
      <p className="group-note">
        {room.settings.control === 'everyone' ? 'أي حد يشغّل ويوقّف ويقدّم ويغيّر القايمة.' : 'الباقي يقدروا يضيفوا لآخر القايمة ويتكلموا ويتفاعلوا بس.'}
      </p>

      <h3 className="group-title">الغرفة</h3>
      <div className="group">
        <Row
          title="استنى اللي بيحمّل"
          sub="لو حد النت عنده وقف، الغرفة توقف لحد ما يلحق"
          end={<Switch label="استنى اللي بيحمّل" checked={room.settings.waitForBuffering} onChange={(v) => (isHost ? void set({ waitForBuffering: v }) : toast('المضيف بس اللي يغيّر ده.'))} />}
        />
        <Row
          title="اقفل الغرفة"
          sub="أي حد جديد يستأذن الأول"
          end={<Switch label="اقفل الغرفة" checked={room.settings.locked} onChange={(v) => (isHost ? void set({ locked: v }) : toast('المضيف بس اللي يغيّر ده.'))} />}
        />
      </div>
      {!isHost && <p className="group-note">المضيف بس اللي يغيّر إعدادات الغرفة.</p>}

      <h3 className="group-title">على الجهاز ده</h3>
      <div className="group">
        <Row title="وطّي الفيديو لما حد يتكلم" end={<Switch label="وطّي الفيديو لما حد يتكلم" checked={duck} onChange={onDuck} />} />
      </div>
      <form
        style={{ display: 'flex', gap: 8, marginTop: 12 }}
        onSubmit={async (e) => {
          e.preventDefault();
          const n = name.trim();
          if (!n) return;
          writePref('name', n);
          await client.rename(n);
          toast('اتغيّر اسمك.');
        }}
      >
        <label className="visually-hidden" htmlFor="rename">اسمك</label>
        <input id="rename" className="field" maxLength={24} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn btn-gray" type="submit" disabled={!name.trim() || name.trim() === me?.name}>
          احفظ
        </button>
      </form>

      <h3 className="group-title">اختصارات الكيبورد</h3>
      <div className="group">
        <Row title="تشغيل وإيقاف" end={<kbd>Space</kbd>} />
        <Row title="قدّم أو رجّع ١٠ ثواني" end={<kbd>J / L</kbd>} />
        <Row title="تفاعل سريع" end={<kbd>1 … 6</kbd>} />
        <Row title="اكتب في الشات" end={<kbd>C</kbd>} />
        <Row title="إضافة" end={<kbd>A</kbd>} />
        <Row title="كتم الفيديو" end={<kbd>M</kbd>} />
      </div>
      <p className="group-note">
        البث مش بيوصل؟ الشبكات اللي ورا NAT صعب (زي باقات الموبايل) محتاجة سيرفر TURN. صاحب السيرفر يضبطه من متغيرات TURN_URL في README.
      </p>
    </Sheet>
  );
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export function SpeedSheet({ open, onClose, rate, onPick }: { open: boolean; onClose: () => void; rate: number; onPick: (r: number) => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="السرعة للكل">
      <div className="group" style={{ marginTop: 8 }}>
        {SPEEDS.map((s) => (
          <Row
            key={s}
            as="button"
            title={s === 1 ? 'عادي' : `${s}×`}
            end={s === rate ? <span style={{ color: 'var(--tint)' }}>✓</span> : undefined}
            onClick={() => {
              onPick(s);
              onClose();
            }}
          />
        ))}
      </div>
      <p className="group-note">مفيدة للكورسات: الغرفة كلها بتسرّع مع بعض.</p>
    </Sheet>
  );
}
