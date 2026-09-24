import { useEffect, useMemo, useRef, useState } from 'react';
import type { NewItem, QueueMode } from '../../../shared/protocol.ts';
import { parseLink, titleFromUrl, youtubeThumb, type ParsedLink, type YouTubePlaylist } from '../../../shared/links.ts';
import { client } from '../lib/room-client.ts';
import { toast } from '../lib/hooks.ts';
import { expandPlaylist, fetchMeta } from '../player/playlist.ts';
import { canBroadcastScreen } from '../rtc/voice.ts';
import { Icon } from './Icon.tsx';
import { Sheet } from './Sheet.tsx';
import { Segmented } from './ui.tsx';

interface AddSheetProps {
  open: boolean;
  onClose: () => void;
  initialUrl?: string;
  onBroadcastScreen: () => void;
  onBroadcastFile: (file: File) => void;
}

export function AddSheet({ open, onClose, initialUrl, onBroadcastScreen, onBroadcastFile }: AddSheetProps) {
  const [url, setUrl] = useState('');
  const [scope, setScope] = useState<'video' | 'playlist'>('playlist');
  const [meta, setMeta] = useState<{ title: string | null; thumb: string | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const canControl = client.canControl;

  useEffect(() => {
    if (open) {
      setUrl(initialUrl ?? '');
      setError('');
      setBusy(null);
      setPickedFile(null);
    }
  }, [open, initialUrl]);

  const parsed = useMemo(() => parseLink(url), [url]);
  const playlist: YouTubePlaylist | undefined = parsed.ok ? parsed.link.playlist : parsed.reason === 'playlist-only' ? parsed.playlist : undefined;
  const single: ParsedLink | null = parsed.ok ? parsed.link : null;
  const usePlaylist = !!playlist && (scope === 'playlist' || !single);

  // Preview: title and thumbnail as soon as the link makes sense.
  useEffect(() => {
    setMeta(null);
    if (!single) return;
    const s = single.source;
    let alive = true;
    if (s.kind === 'youtube') {
      setMeta({ title: null, thumb: youtubeThumb(s.id) });
      void fetchMeta('youtube', s.id).then((m) => alive && setMeta({ title: m.title, thumb: youtubeThumb(s.id) }));
    } else if (s.kind === 'vimeo') {
      void fetchMeta('vimeo', s.id).then((m) => alive && setMeta(m));
    } else if (s.kind === 'direct') {
      setMeta({ title: titleFromUrl(s.url), thumb: null });
    }
    return () => {
      alive = false;
    };
  }, [single?.source.kind === 'youtube' ? single.source.id : single?.source.kind === 'vimeo' ? single.source.id : url]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (mode: QueueMode) => {
    setError('');
    let items: NewItem[] = [];

    if (usePlaylist && playlist) {
      if (playlist.personal) {
        setError('دي ليستة شخصية (المشاهدة لاحقًا أو الإعجابات) ويوتيوب مش بيسمح تتفتح برا حسابك. اعمل منها بلاي ليست عامة أو غير مدرجة.');
        return;
      }
      setBusy('بيقرا البلاي ليست…');
      const res = await expandPlaylist(playlist, single?.source.kind === 'youtube' ? single.source.id : undefined);
      setBusy(null);
      if (!res.ok) {
        if (single) {
          toast(playlist.mix ? 'الميكس ده بيتغيّر لكل شخص، فضفت الفيديو لوحده.' : 'البلاي ليست ما اتفتحتش، فضفت الفيديو لوحده.');
        } else {
          setError(
            res.reason === 'timeout'
              ? 'يوتيوب ما ردّش. جرّب تاني.'
              : 'البلاي ليست دي خاصة أو فاضية. اتأكد إنها عامة أو غير مدرجة.',
          );
          return;
        }
      } else {
        const ids = res.ids.slice(res.startIndex);
        items = ids.map((id, i) => ({
          source: { kind: 'youtube', id },
          title: `فيديو ${res.startIndex + i + 1} من البلاي ليست`,
          ...(i === 0 && single?.startAt ? { startAt: single.startAt } : {}),
        }));
        if (res.startIndex > 0) toast(`بدأت من الفيديو رقم ${res.startIndex + 1}، زي اللينك.`);
      }
    }

    if (items.length === 0 && single) {
      const s = single.source;
      items = [
        {
          source: s,
          title: meta?.title ?? (s.kind === 'direct' ? titleFromUrl(s.url) : 'بدون عنوان'),
          ...(meta?.thumb && s.kind === 'vimeo' ? { thumb: meta.thumb } : {}),
          ...(single.startAt ? { startAt: single.startAt } : {}),
        },
      ];
    }
    if (items.length === 0) return;

    const res = await client.add(items, mode);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (items.length > 1) toast(`اتضاف ${items.length} فيديو للقايمة.`);
    else if (mode !== 'now') toast(mode === 'next' ? 'هيشتغل بعد اللي شغّال.' : 'اتضاف لآخر القايمة.');
    onClose();
  };

  const addLocal = async (file: File, mode: QueueMode) => {
    const res = await client.add([{ source: { kind: 'local', name: file.name, size: file.size }, title: file.name.replace(/\.[^.]+$/, '') }], mode);
    if (!res.ok) setError(res.error);
    else {
      toast('كل واحد هيختار نسخته من نفس الملف.');
      onClose();
    }
  };

  const unsupported = !parsed.ok && parsed.reason === 'unsupported' && url.trim().length > 0;
  const ready = !!single || !!playlist;
  const screenOk = canBroadcastScreen();

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="إضافة"
      trailing={
        <button className="btn btn-plain" onClick={onClose}>
          إلغاء
        </button>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !busy) void submit(canControl ? 'now' : 'end');
        }}
      >
        <label className="visually-hidden" htmlFor="add-url">لينك</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            id="add-url"
            data-autofocus
            className="field field-ltr"
            placeholder="لينك يوتيوب، بلاي ليست، Vimeo، أو ملف"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          {'clipboard' in navigator && 'readText' in navigator.clipboard && (
            <button
              type="button"
              className="btn btn-gray"
              style={{ minHeight: 50, flex: 'none' }}
              onClick={async () => {
                try {
                  setUrl((await navigator.clipboard.readText()).trim());
                } catch {
                  toast('المتصفح ما سمحش بالقراءة من الحافظة. الصق بإيدك.');
                }
              }}
            >
              لصق
            </button>
          )}
        </div>
      </form>

      {playlist && single && (
        <div style={{ marginTop: 12 }}>
          <Segmented
            label="نطاق"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'playlist', label: 'البلاي ليست كلها' },
              { value: 'video', label: 'الفيديو ده بس' },
            ]}
          />
        </div>
      )}

      {ready && (
        <div className="preview">
          <span className="q-thumb">{meta?.thumb ? <img src={meta.thumb} alt="" /> : <Icon name={usePlaylist ? 'list' : 'film'} />}</span>
          <span className="preview-text">
            <span className="q-title">{usePlaylist ? 'بلاي ليست يوتيوب' : meta?.title ?? 'فيديو'}</span>
            <span className="q-sub" style={{ display: 'block' }}>
              {usePlaylist
                ? playlist?.mix
                  ? 'ميكس: بيتغيّر لكل شخص، هنجرب نقراه'
                  : 'هتتحول لقايمة الغرفة، وكلكم هتتفرجوا على نفس الفيديو في نفس الوقت'
                : single?.startAt
                  ? `هيبدأ من الثانية ${Math.round(single.startAt)}`
                  : single?.source.kind === 'direct'
                    ? 'رابط مباشر'
                    : single?.source.kind === 'vimeo'
                      ? 'Vimeo'
                      : 'يوتيوب'}
            </span>
          </span>
        </div>
      )}

      {busy && (
        <p className="hint" role="status">
          {busy}
        </p>
      )}
      {error && (
        <p className="hint error" role="alert">
          {error}
        </p>
      )}
      {unsupported && (
        <p className="hint warn">
          Loty مش بيقدر يفتح الصفحة دي جوه الغرفة. لو فيها فيديو (كورس، موقع بحساب، منصة تانية) افتحها في تاب وابثّها من تحت.
        </p>
      )}

      {ready &&
        (canControl ? (
          <div className="mode-row">
            <button className="btn btn-filled" disabled={!!busy} onClick={() => void submit('now')}>
              شغّل دلوقتي
            </button>
            <button className="btn btn-gray" disabled={!!busy} onClick={() => void submit('next')}>
              بعد اللي شغّال
            </button>
            <button className="btn btn-gray" disabled={!!busy} onClick={() => void submit('end')}>
              آخر القايمة
            </button>
          </div>
        ) : (
          <button className="btn btn-filled btn-wide" style={{ marginTop: 12 }} disabled={!!busy} onClick={() => void submit('end')}>
            ضيف لآخر القايمة
          </button>
        ))}

      <h3 className="group-title">حاجة مش لينك</h3>
      <div className="group">
        <button className="row" disabled={!screenOk || !canControl} onClick={() => { onClose(); onBroadcastScreen(); }}>
          <span className="row-icon" style={{ background: '#ff9f0a' }}>
            <Icon name="broadcast" size="sm" />
          </span>
          <span className="row-text">
            <span className="row-title">ابث تاب أو شاشة</span>
            <span className="row-sub" style={{ display: 'block' }}>
              {screenOk
                ? 'لأي موقع أو كورس محتاج تسجيل دخول: انت بس اللي تفتحه والباقي يتفرج'
                : 'البث محتاج كمبيوتر (Chrome أو Edge أو Firefox). الموبايل يقدر يتفرج عادي'}
            </span>
          </span>
        </button>
        <button className="row" onClick={() => fileRef.current?.click()}>
          <span className="row-icon" style={{ background: '#30b0c7' }}>
            <Icon name="file" size="sm" />
          </span>
          <span className="row-text">
            <span className="row-title">ملف من جهازك</span>
            <span className="row-sub" style={{ display: 'block' }}>
              فيلم أو محاضرة متحمّلة عندك
            </span>
          </span>
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="video/*,audio/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) setPickedFile(f);
          e.target.value = '';
        }}
      />
      {pickedFile && (
        <>
          <h3 className="group-title">
            <bdi>{pickedFile.name}</bdi>
          </h3>
          <div className="group">
            <button className="row" onClick={() => void addLocal(pickedFile, canControl ? 'now' : 'end')}>
              <span className="row-text">
                <span className="row-title">كل واحد يفتح نسخته</span>
                <span className="row-sub" style={{ display: 'block' }}>
                  الأفضل لو الملف عند الكل: جودة كاملة ومن غير أي نت تقريبًا
                </span>
              </span>
            </button>
            <button
              className="row"
              disabled={!canControl}
              onClick={() => {
                onClose();
                onBroadcastFile(pickedFile);
              }}
            >
              <span className="row-text">
                <span className="row-title">ابثّه للباقي</span>
                <span className="row-sub" style={{ display: 'block' }}>
                  الملف عندك انت بس. بيتبعت من جهازك، فسرعة الرفع عندك مهمة
                </span>
              </span>
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
