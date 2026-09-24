import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { REACTIONS, type QueueItem, type RoomSnapshot } from '../../../shared/protocol.ts';
import { youtubeThumb } from '../../../shared/links.ts';
import { client } from '../lib/room-client.ts';
import { haptic, readPref, toast, useMediaQuery, usePrefersReducedMotion, writePref } from '../lib/hooks.ts';
import { navigate } from '../lib/router.ts';
import { springs } from '../lib/physics.ts';
import { SyncController, type StageStatus } from '../player/controller.ts';
import { Mesh } from '../rtc/mesh.ts';
import { canBroadcastScreen, captureVideo, openMic, openScreen, SpeakingMeter } from '../rtc/voice.ts';
import { edgeColors, loadImage } from '../three/palette.ts';
import type { ReactionLayer } from '../three/reactions.ts';
import { AddSheet } from './AddSheet.tsx';
import { useAmbient, useAmbientRect } from './AmbientCanvas.tsx';
import { ChatPanel } from './ChatPanel.tsx';
import { Icon } from './Icon.tsx';
import { PeoplePanel } from './PeoplePanel.tsx';
import { QueuePanel } from './QueuePanel.tsx';
import { InviteSheet, SettingsSheet, SpeedSheet } from './RoomSheets.tsx';
import { Stage, type StageHandle } from './Stage.tsx';
import { Avatar, Segmented } from './ui.tsx';

type Tab = 'chat' | 'queue' | 'people';
type SheetName = 'add' | 'invite' | 'settings' | 'speed' | null;

const idle: StageStatus = { loading: false, error: null, needsTap: false, needsFile: null, waitingForStream: false, sync: 'idle', drift: 0 };

export function RoomView({ room, me }: { room: RoomSnapshot; me: string }) {
  const stageRef = useRef<StageHandle>(null);
  const [controller, setController] = useState<SyncController | null>(null);
  const [tab, setTab] = useState<Tab>('chat');
  const [sheet, setSheet] = useState<SheetName>(null);
  const [addUrl, setAddUrl] = useState<string | undefined>();
  const [mini, setMini] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [duck, setDuck] = useState(() => readPref('duck', true));
  const [reactOpen, setReactOpen] = useState(false);
  const reactBtn = useRef<HTMLButtonElement>(null);
  const wide = useMediaQuery('(min-width: 960px)');
  const reduce = usePrefersReducedMotion();
  const ambient = useAmbient();

  const meMember = room.members.find((m) => m.id === me);
  const isHost = !!meMember?.isHost;
  const canControl = room.settings.control === 'everyone' || isHost;
  const current: QueueItem | null = room.playback.itemId && room.queue[0]?.id === room.playback.itemId ? room.queue[0]! : null;

  // ── media plumbing that must outlive renders ──
  const mesh = useMemo(() => new Mesh(me, (to, signal) => client.socket.emit('rtc:signal', { to, signal })), [me]);
  const meter = useMemo(() => new SpeakingMeter(), []);
  const micRef = useRef<MediaStream | null>(null);
  const broadcastRef = useRef<{ stream?: MediaStream; file?: File } | null>(null);
  const roomRef = useRef(room);
  roomRef.current = room;

  useEffect(() => {
    const onSignal = ({ from, signal }: { from: string; signal: Parameters<Mesh['handleSignal']>[1] }) => void mesh.handleSignal(from, signal);
    client.socket.on('rtc:signal', onSignal);
    return () => {
      client.socket.off('rtc:signal', onSignal);
      mesh.destroy();
      meter.destroy();
      micRef.current?.getTracks().forEach((t) => t.stop());
      broadcastRef.current?.stream?.getTracks().forEach((t) => t.stop());
    };
  }, [mesh, meter]);

  const meshVersion = useSyncExternalStore(mesh.subscribe, mesh.getVersion);
  const speaking = useSyncExternalStore(meter.subscribe, meter.getSpeaking);

  const onlineIds = room.members.filter((m) => m.online).map((m) => m.id).join(',');
  useEffect(() => {
    void mesh.setMembers(onlineIds.split(',').filter(Boolean));
  }, [mesh, onlineIds]);

  const publishStreams = useCallback(() => {
    const streams: { voice?: string; screen?: string } = {};
    if (micRef.current) streams.voice = micRef.current.id;
    const b = broadcastRef.current?.stream;
    if (b) streams.screen = b.id;
    client.media({ micOn: !!micRef.current, streams });
  }, []);

  // ── the synced player ──
  useEffect(() => {
    const host = stageRef.current?.media;
    if (!host) return;
    const c = new SyncController(host, {
      client,
      remoteScreen: (memberId) => mesh.streamById(roomRef.current.members.find((m) => m.id === memberId)?.streams.screen),
      localBroadcast: () => broadcastRef.current,
      onBroadcastVideo: (video) => {
        if (!video || !broadcastRef.current?.file) return;
        const start = () => {
          if (broadcastRef.current?.stream) return; // already captured from this broadcast
          const stream = captureVideo(video);
          if (!stream) {
            toast('المتصفح ده مش بيقدر يبث ملف. جرّب Chrome أو Firefox على الكمبيوتر، أو خلي كل واحد يفتح نسخته.');
            return;
          }
          broadcastRef.current = { ...broadcastRef.current, stream };
          stream.onaddtrack = () => mesh.resync();
          void mesh.setLocal('screen', stream);
          publishStreams();
        };
        if (video.readyState >= 3 && !video.paused) start();
        else video.addEventListener('playing', start, { once: true });
      },
      toast: (m) => toast(m),
    });
    setController(c);
    // Field diagnostics: with sessionStorage 'loty.debug' set, the controller's view is mirrored
    // into the DOM, where any devtools (or test driver) can read it.
    let debugTimer = 0;
    try {
      if (sessionStorage.getItem('loty.debug')) {
        debugTimer = window.setInterval(() => (document.documentElement.dataset.lotyDebug = JSON.stringify(c.debug())), 250);
      }
    } catch {
      /* storage blocked */
    }
    return () => {
      window.clearInterval(debugTimer);
      c.destroy();
    };
  }, [mesh, publishStreams]);

  useEffect(() => {
    controller?.update(current, room.playback);
  }, [controller, current, room.playback]);

  useEffect(() => {
    controller?.refresh();
  }, [controller, meshVersion, room.members]);

  const status = useSyncExternalStore(
    (fn) => controller?.subscribe(fn) ?? (() => {}),
    () => controller?.getStatus() ?? idle,
  );

  // ── voice ──
  const voiceStreams = useMemo(() => {
    const map = new Map<string, MediaStream>();
    for (const m of room.members) {
      if (m.id === me) continue;
      const s = mesh.streamById(m.streams.voice);
      if (s) map.set(m.id, s);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.members, meshVersion, me, mesh]);

  useEffect(() => {
    const all = new Map(voiceStreams);
    if (micRef.current && micOn) all.set(me, micRef.current);
    meter.track(all);
  }, [voiceStreams, micOn, me, meter]);

  useEffect(() => {
    const othersTalking = [...speaking].some((id) => id !== me);
    controller?.duck(duck && othersTalking ? 0.3 : 1);
  }, [speaking, duck, controller, me]);

  const toggleMic = async () => {
    if (micRef.current) {
      micRef.current.getTracks().forEach((t) => t.stop());
      micRef.current = null;
      setMicOn(false);
      await mesh.setLocal('voice', null);
      publishStreams();
      return;
    }
    try {
      const s = await openMic();
      micRef.current = s;
      setMicOn(true);
      await mesh.setLocal('voice', s);
      publishStreams();
      haptic();
      if (!readPref('headphonesTip', false)) {
        toast('نصيحة: السماعات بتمنع صوت الفيديو يرجع في المايك.');
        writePref('headphonesTip', true);
      }
    } catch (err) {
      const name = (err as DOMException).name;
      toast(name === 'NotAllowedError' ? 'المتصفح منع المايك. اسمح بيه من أيقونة القفل جنب العنوان.' : 'مفيش مايك شغّال على الجهاز ده.');
    }
  };

  // ── broadcast ──
  const stopLocalBroadcast = useCallback(() => {
    broadcastRef.current?.stream?.getTracks().forEach((t) => t.stop());
    broadcastRef.current = null;
    void mesh.setLocal('screen', null);
    publishStreams();
  }, [mesh, publishStreams]);

  const stopBroadcast = () => {
    stopLocalBroadcast();
    client.stopBroadcast();
  };

  const startScreen = async () => {
    if (!canBroadcastScreen()) {
      toast('البث محتاج كمبيوتر (Chrome أو Edge أو Firefox).');
      return;
    }
    if (!canControl) {
      toast('المضيف بس اللي يقدر يبث دلوقتي.');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await openScreen();
    } catch {
      return; // picker dismissed
    }
    stopLocalBroadcast();
    broadcastRef.current = { stream };
    await mesh.setLocal('screen', stream);
    publishStreams();
    const video = stream.getVideoTracks()[0];
    if (video) video.onended = () => stopBroadcast();
    if (stream.getAudioTracks().length === 0) toast('البث شغّال من غير صوت. عشان الصوت: اختار "تاب" وعلّم على "مشاركة صوت التاب".');
    const label = video?.label.replace(/^(web-contents-media-stream|window|screen):.*$/i, '') || 'شاشة';
    const res = await client.startBroadcast(label.slice(0, 40) || 'شاشة', 'screen');
    if (!res.ok) {
      toast(res.error);
      stopLocalBroadcast();
    }
  };

  const startFile = async (file: File) => {
    stopLocalBroadcast();
    broadcastRef.current = { file };
    const res = await client.startBroadcast(file.name.replace(/\.[^.]+$/, ''), 'file');
    if (!res.ok) {
      toast(res.error);
      broadcastRef.current = null;
    }
  };

  // Someone skipped my broadcast: stop sending.
  const myBroadcastLive = room.queue.some((q) => q.source.kind === 'broadcast' && q.source.hostId === me);
  useEffect(() => {
    if (!myBroadcastLive && broadcastRef.current) stopLocalBroadcast();
  }, [myBroadcastLive, stopLocalBroadcast]);

  // ── ambient light from what is playing ──
  const stageEl = stageRef.current?.element ?? null;
  const stageElRef = useRef<HTMLElement | null>(null);
  stageElRef.current = stageEl;
  useAmbientRect(stageElRef, wide && !mini ? 18 : mini ? 14 : 0, !!stageEl);

  useEffect(() => {
    if (!ambient) return;
    if (!current) {
      ambient.setColors(null);
      return;
    }
    let alive = true;
    let timer = 0;
    const s = current.source;
    const thumb = s.kind === 'youtube' ? youtubeThumb(s.id) : current.thumb;
    if (thumb) {
      void loadImage(`/api/img?u=${encodeURIComponent(thumb)}`).then((img) => {
        if (alive && img) ambient.setColors(edgeColors(img, img.naturalWidth, img.naturalHeight));
      });
    }
    // Readable video (files, direct links with CORS, broadcasts): follow the picture itself.
    const sample = () => {
      const v = controller?.video;
      if (v && v.readyState >= 2 && !v.paused) {
        const colors = edgeColors(v, v.videoWidth, v.videoHeight);
        if (colors) ambient.setColors(colors);
      }
    };
    timer = window.setInterval(sample, 500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [ambient, current?.id, controller, status.loading]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => ambient?.setColors(null), [ambient]);

  // ── reactions (Three.js) ──
  const layerRef = useRef<ReactionLayer | null>(null);
  useEffect(() => {
    const canvas = stageRef.current?.reactions;
    if (!canvas) return;
    let layer: ReactionLayer | null = null;
    let cancelled = false;
    const ro = new ResizeObserver(([e]) => e && layer?.resize(e.contentRect.width, e.contentRect.height));
    void import('../three/reactions.ts').then(({ ReactionLayer }) => {
      if (cancelled) return;
      try {
        layer = new ReactionLayer(canvas, reduce);
      } catch {
        return; // no WebGL: reactions still show up as nothing worse than silence
      }
      layerRef.current = layer;
      ro.observe(canvas);
    });
    const onReact = ({ emoji }: { emoji: string }) => layer?.burst(emoji);
    client.onReact.add(onReact);
    return () => {
      cancelled = true;
      client.onReact.delete(onReact);
      ro.disconnect();
      layer?.dispose();
      layerRef.current = null;
    };
  }, [reduce]);

  const react = (emoji: string) => {
    client.react(emoji);
    haptic(6);
  };

  // ── notifications ──
  const tabRef = useRef(tab);
  tabRef.current = tab;
  useEffect(() => {
    const onChat = (m: { from: string | null; name: string; text: string; hue: number }) => {
      if (!m.from || m.from === me) return;
      const chatVisible = tabRef.current === 'chat' && !document.hidden;
      if (!chatVisible) toast({ from: m.name, hue: m.hue, text: m.text.length > 80 ? `${m.text.slice(0, 80)}…` : m.text });
    };
    client.onChat.add(onChat);
    return () => {
      client.onChat.delete(onChat);
    };
  }, [me]);

  const knocks = useSyncExternalStore(client.subscribe, () => client.getState().knocks);
  const shownKnocks = useRef(new Set<string>());
  useEffect(() => {
    for (const k of knocks) {
      if (shownKnocks.current.has(k.id)) continue;
      shownKnocks.current.add(k.id);
      toast({
        text: `طلب دخول من ${k.name}`,
        duration: 0,
        actions: [
          { label: 'لأ', onClick: () => client.answerKnock(k.id, false) },
          { label: 'دخّله', primary: true, onClick: () => client.answerKnock(k.id, true) },
        ],
      });
    }
  }, [knocks]);

  // ── keyboard ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.closest('input, textarea, [contenteditable]') || sheet) return;
      const k = e.key.toLowerCase();
      if (k === ' ' || k === 'k') {
        e.preventDefault();
        controller?.togglePlay();
      } else if (k === 'j' || k === 'arrowright') controller?.seekBy(k === 'j' ? -10 : -5); // RTL: → goes back
      else if (k === 'l' || k === 'arrowleft') controller?.seekBy(k === 'l' ? 10 : 5);
      else if (k === 'm') controller?.setMuted(!controller.isMuted());
      else if (k === 'c') {
        e.preventDefault();
        setTab('chat');
        requestAnimationFrame(() => document.getElementById('composer')?.focus());
      } else if (k === 'a') {
        e.preventDefault();
        setSheet('add');
      } else if (/^[1-6]$/.test(k)) react(REACTIONS[Number(k) - 1]!);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // re-bound each render on purpose: it reads the latest sheet/controller

  // ── derived UI ──
  const leave = () => {
    stopLocalBroadcast();
    client.leave();
    navigate('/');
  };

  const seekFromChat = (t: number) => {
    if (!current || current.source.kind === 'broadcast') return;
    if (!canControl) {
      toast('المضيف بس اللي يقدر ينقل الفيديو.');
      return;
    }
    controller?.seekTo(t);
    haptic();
  };

  const syncLabel: Record<StageStatus['sync'], string> = {
    idle: '',
    synced: 'متزامن',
    'catching-up': status.drift > 0 ? 'بيستنى الباقي' : 'بيلحق الباقي',
    buffering: 'بيحمّل',
    live:
      current?.source.kind === 'broadcast'
        ? `مباشر من ${room.members.find((m) => m.id === (current.source as { hostId: string }).hostId)?.name ?? 'حد'}`
        : 'مباشر',
  };
  const others = room.members.filter((m) => m.id !== me);
  const title = current?.title ?? 'مفيش حاجة شغّالة';

  return (
    <div className="room">
      <header className="topbar">
        <button className="icon-btn" onClick={leave} aria-label="اخرج من الغرفة">
          <Icon name="leave" />
        </button>
        <div className="topbar-title">
          <button className="code-chip" onClick={() => setSheet('invite')} aria-label={`كود الغرفة ${room.code}. دوس للدعوة`}>
            <span className={`conn-dot${client.getState().connected ? '' : ' off'}`} aria-hidden />
            {room.code.slice(0, 3)} {room.code.slice(3)}
            {room.settings.locked && <Icon name="lock" size="sm" />}
          </button>
        </div>
        <button className="avatar-stack" onClick={() => setTab('people')} aria-label={`${room.members.length} في الغرفة`} style={{ padding: '0 6px' }}>
          {room.members.slice(0, 4).map((m) => (
            <Avatar key={m.id} name={m.name} hue={m.hue} size={28} speaking={speaking.has(m.id)} offline={!m.online} />
          ))}
        </button>
        <button className="icon-btn" onClick={() => setSheet('settings')} aria-label="إعدادات الغرفة">
          <Icon name="gear" />
        </button>
      </header>

      <section className="main" aria-label="المشغّل">
        <Stage
          ref={stageRef}
          controller={controller}
          item={current}
          playback={room.playback}
          mini={mini}
          onExitMini={() => setMini(false)}
          onAdd={() => setSheet('add')}
          onBroadcast={() => void startScreen()}
          onSkip={() => void client.skip()}
          canControl={canControl}
        />

        <div className="now">
          <div className="now-text">
            <h1 className="now-title">
              <bdi>{title}</bdi>
            </h1>
            <div className="now-sub">
              {current && status.sync !== 'idle' && <span className={`sync-pill ${status.sync}`} data-drift={status.drift.toFixed(2)}>{syncLabel[status.sync]}</span>}
              {current && current.source.kind !== 'broadcast' && (
                <button className="speed-btn" dir="ltr" onClick={() => (canControl ? setSheet('speed') : toast('المضيف بس اللي يغيّر السرعة.'))} aria-label="سرعة التشغيل">
                  {room.playback.rate === 1 ? '1×' : `${room.playback.rate}×`}
                </button>
              )}
              {others.length === 0 && <span>لوحدك لسه. ادعي حد من الكود فوق.</span>}
            </div>
          </div>
        </div>

        <div className="toolbar">
          <button className="btn btn-filled add-btn" onClick={() => setSheet('add')}>
            <Icon name="plus" size="sm" /> إضافة
          </button>
          <span className="spacer" />
          {myBroadcastLive && (
            <button className="icon-btn live" onClick={stopBroadcast} aria-label="وقف البث">
              <Icon name="broadcast" />
            </button>
          )}
          <button className={`icon-btn filled${micOn ? ' on' : ''}`} onClick={() => void toggleMic()} aria-pressed={micOn} aria-label={micOn ? 'اقفل المايك' : 'افتح المايك'}>
            <Icon name={micOn ? 'mic' : 'micOff'} />
          </button>
          <button ref={reactBtn} className="icon-btn filled" onClick={() => setReactOpen((v) => !v)} aria-expanded={reactOpen} aria-label="تفاعل">
            <Icon name="heart" />
          </button>
          {!wide && (
            <button className={`icon-btn filled${mini ? ' on' : ''}`} onClick={() => setMini((v) => !v)} aria-pressed={mini} aria-label="مشغّل صغير عائم">
              <Icon name="pip" />
            </button>
          )}
        </div>
      </section>

      <aside className="side" aria-label="الشات والقايمة والناس">
        <div className="side-head">
          <Segmented<Tab>
            label="اللوحة"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'chat', label: 'الشات' },
              { value: 'queue', label: 'القايمة', count: Math.max(0, room.queue.length - (current ? 1 : 0)) },
              { value: 'people', label: 'الناس', count: room.members.filter((m) => m.online).length },
            ]}
          />
        </div>
        {tab === 'chat' && (
          <ChatPanel
            onSeek={seekFromChat}
            speaking={speaking}
            onAddLink={(url) => {
              setAddUrl(url);
              setSheet('add');
            }}
          />
        )}
        {tab === 'queue' && <QueuePanel onAdd={() => setSheet('add')} />}
        {tab === 'people' && <PeoplePanel speaking={speaking} onInvite={() => setSheet('invite')} />}
      </aside>

      <ReactionPopover open={reactOpen} anchor={reactBtn} onPick={react} onClose={() => setReactOpen(false)} />

      {/* Remote voices play here; video audio stays in the player. */}
      <div hidden>
        {[...voiceStreams].map(([id, stream]) => (
          <RemoteAudio key={id} stream={stream} />
        ))}
      </div>

      <AddSheet
        open={sheet === 'add'}
        initialUrl={addUrl}
        onClose={() => {
          setSheet(null);
          setAddUrl(undefined);
        }}
        onBroadcastScreen={() => void startScreen()}
        onBroadcastFile={(f) => void startFile(f)}
      />
      <InviteSheet open={sheet === 'invite'} onClose={() => setSheet(null)} code={room.code} />
      <SettingsSheet
        open={sheet === 'settings'}
        onClose={() => setSheet(null)}
        room={room}
        isHost={isHost}
        duck={duck}
        onDuck={(v) => {
          setDuck(v);
          writePref('duck', v);
        }}
      />
      <SpeedSheet
        open={sheet === 'speed'}
        onClose={() => setSheet(null)}
        rate={room.playback.rate}
        onPick={(rate) => {
          if (!current) return;
          void client.command({ type: 'rate', rate, position: controller?.currentTime() ?? 0, itemId: current.id }).then((r) => {
            if (!r.ok) toast(r.error);
          });
        }}
      />
    </div>
  );
}

function RemoteAudio({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    void el.play().catch(() => {
      // Autoplay blocked: start on the next tap anywhere.
      const resume = () => void el.play().catch(() => {});
      window.addEventListener('pointerdown', resume, { once: true });
    });
  }, [stream]);
  return <audio ref={ref} autoPlay playsInline />;
}

/** Anchored to its button: grows out of it and returns into it. */
function ReactionPopover({ open, anchor, onPick, onClose }: { open: boolean; anchor: React.RefObject<HTMLButtonElement | null>; onPick: (e: string) => void; onClose: () => void }) {
  const reduce = usePrefersReducedMotion();
  const [pos, setPos] = useState<{ left: number; top: number; originX: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    const width = REACTIONS.length * 46 + 12;
    const left = Math.max(12, Math.min(window.innerWidth - width - 12, r.left + r.width / 2 - width / 2));
    setPos({ left, top: r.top - 64, originX: r.left + r.width / 2 - left });
    const close = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest('.popover') && !anchor.current?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open, anchor, onClose]);

  return (
    <AnimatePresence>
      {open && pos && (
        <motion.div
          className="popover"
          role="menu"
          aria-label="تفاعلات"
          style={{ left: pos.left, top: pos.top, transformOrigin: `${pos.originX}px 100%` }}
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6, filter: 'blur(6px)' }}
          animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6, filter: 'blur(6px)' }}
          transition={reduce ? { duration: 0.12 } : springs.snappy}
        >
          {REACTIONS.map((e) => (
            <motion.button key={e} role="menuitem" onClick={() => onPick(e)} whileTap={reduce ? undefined : { scale: 0.85 }} aria-label={e}>
              {e}
            </motion.button>
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
