import express from 'express';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server, type Socket } from 'socket.io';
import { LIMITS, REACTIONS, type ClientToServer, type ServerToClient } from '../shared/protocol.ts';
import { metaRouter, oembed } from './meta.ts';
import { cleanName, HOLD_LIMIT_MS, isPlaceholderTitle, newId, newRoomCode, normalizeCode, Room, type Result } from './room.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const PORT = Number(process.env.PORT ?? 4000);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use((_req, res, next) => {
  res.set({
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin', // YouTube refuses embeds without a referrer (error 153)
    'permissions-policy': 'camera=(), geolocation=()',
  });
  next();
});
app.use('/api', metaRouter());
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

if (existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1y', immutable: true, setHeaders: (res, path) => {
    if (!path.includes(`${join('dist', 'assets')}`)) res.setHeader('cache-control', 'no-cache');
  } }));
  // Client-side routes: /r/CODE and anything else that is not a file.
  app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => {
    res.set('cache-control', 'no-cache').sendFile(join(dist, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.type('text').send('Loty server is running. Run `npm run dev` and open http://localhost:5173, or `npm run build` first.');
  });
}

const http = createServer(app);
const io = new Server<ClientToServer, ServerToClient>(http, {
  cors: process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN.split(',') } : undefined,
  maxHttpBufferSize: 200_000,
  pingInterval: 10_000,
  pingTimeout: 8_000,
});

const rooms = new Map<string, Room>();

/** Token bucket per socket and action, so one tab cannot flood a room. */
function limiter(capacity: number, perSecond: number) {
  const buckets = new WeakMap<Socket, { tokens: number; at: number }>();
  return (socket: Socket) => {
    const now = Date.now();
    const b = buckets.get(socket) ?? { tokens: capacity, at: now };
    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * perSecond);
    b.at = now;
    buckets.set(socket, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}
const allow = {
  join: limiter(6, 0.2),
  chat: limiter(6, 1.5),
  react: limiter(12, 4),
  command: limiter(12, 4),
  queue: limiter(10, 2),
  typing: limiter(3, 0.5),
  signal: limiter(200, 60),
};

type LotySocket = Socket<ClientToServer, ServerToClient>;

io.on('connection', (socket: LotySocket) => {
  let room: Room | null = null;
  let memberId: string | null = null;
  let knockId: string | null = null;
  let knockRoom: Room | null = null;

  const broadcastState = (r: Room) => io.to(r.code).emit('room:state', r.snapshot());
  const broadcastPlayback = (r: Room) => io.to(r.code).emit('play:state', r.playback);
  const reply = (ack: unknown, res: Result<object>) => {
    if (typeof ack === 'function') ack(res);
  };
  const denied = (ack: unknown) => reply(ack, { ok: false, code: 'rate', error: 'استنى ثانية.' });

  function attach(r: Room, id: string) {
    room = r;
    memberId = id;
    void socket.join(r.code);
    broadcastState(r);
  }

  function withRoom<A extends unknown[]>(fn: (r: Room, me: string, ...args: A) => void) {
    return (...args: A) => {
      if (!room || !memberId || !room.members.has(memberId)) {
        const ack = args[args.length - 1];
        reply(ack, { ok: false, code: 'expired', error: 'انت مش في غرفة.' });
        return;
      }
      fn(room, memberId, ...args);
    };
  }

  socket.on('clock:ping', (_t0, ack) => {
    if (typeof ack === 'function') ack(Date.now());
  });

  socket.on('room:create', ({ name }, ack) => {
    if (!allow.join(socket)) return denied(ack);
    leaveCurrent();
    const r = new Room(newRoomCode((c) => rooms.has(c)));
    rooms.set(r.code, r);
    const m = r.addMember(name, socket.id, Date.now());
    attach(r, m.id);
    ack({ ok: true, session: { code: r.code, memberId: m.id, secret: m.secret } });
  });

  socket.on('room:join', ({ code, name }, ack) => {
    if (!allow.join(socket)) return denied(ack);
    const r = rooms.get(normalizeCode(String(code ?? '')));
    if (!r) return ack({ ok: false, code: 'not-found', error: 'مفيش غرفة بالكود ده. اتأكد منه أو اطلب لينك جديد.' });
    const can = r.canJoin();
    if (!can.ok) return ack(can);
    leaveCurrent();

    if (r.settings.locked) {
      const host = r.host();
      knockId = newId(6);
      knockRoom = r;
      r.knocks.set(knockId, { name: cleanName(name), socketId: socket.id });
      if (host?.socketId) io.to(host.socketId).emit('knock:request', { id: knockId, name: cleanName(name) });
      return ack({ ok: true, waiting: true });
    }
    const m = r.addMember(name, socket.id, Date.now());
    attach(r, m.id);
    ack({ ok: true, session: { code: r.code, memberId: m.id, secret: m.secret } });
  });

  socket.on('room:resume', ({ code, memberId: id, secret }, ack) => {
    if (!allow.join(socket)) return denied(ack);
    const r = rooms.get(normalizeCode(String(code ?? '')));
    if (!r) return ack({ ok: false, code: 'not-found', error: 'الغرفة اتقفلت.' });
    const res = r.resume(String(id), String(secret), socket.id, Date.now());
    if (!res.ok) return ack(res);
    attach(r, res.member.id);
    ack({ ok: true });
    // Tell the host about anyone who knocked while they were away.
    if (res.member.isHost) for (const [kid, k] of r.knocks) socket.emit('knock:request', { id: kid, name: k.name });
  });

  socket.on('room:leave', () => {
    if (room && memberId) {
      const r = room;
      r.remove(memberId, Date.now(), 'left');
      void socket.leave(r.code);
      room = null;
      memberId = null;
      broadcastState(r);
    }
    cancelKnock();
  });

  socket.on('play:command', withRoom((r, me, c, ack) => {
    if (!allow.command(socket)) return denied(ack);
    const res = r.command(me, c, Date.now());
    reply(ack, res);
    if (res.ok) broadcastPlayback(r);
    // A refused command still gets the truth back, so the sender's player snaps to the room.
    else socket.emit('play:state', r.playback);
  }));

  socket.on('play:ended', withRoom((r, _me, { itemId }) => {
    if (r.ended(String(itemId), Date.now())) {
      broadcastState(r);
      void fillTitles(r);
    }
  }));

  const holdTimers = new Map<string, NodeJS.Timeout>();
  socket.on('play:buffering', withRoom((r, me, { buffering }) => {
    r.setBuffering(me, !!buffering, Date.now());
    const check = () => {
      if (r.evaluateHold(Date.now())) {
        broadcastState(r);
        // A hold just started: come back when its time limit runs out.
        if (r.playback.holdFor) setTimeout(check, HOLD_LIMIT_MS + 100);
      }
    };
    clearTimeout(holdTimers.get(r.code));
    if (buffering) holdTimers.set(r.code, setTimeout(check, 1_300));
    else check();
  }));

  socket.on('queue:add', withRoom((r, me, { items, mode }, ack) => {
    if (!allow.queue(socket)) return denied(ack);
    const res = r.addItems(me, Array.isArray(items) ? items.filter(isNewItem) : [], mode === 'now' || mode === 'next' ? mode : 'end', Date.now());
    ack(res);
    if (res.ok) {
      broadcastState(r);
      void fillTitles(r);
    }
  }));

  socket.on('queue:remove', withRoom((r, me, { id }, ack) => {
    const res = r.removeItem(me, String(id), Date.now());
    reply(ack, res);
    if (res.ok) broadcastState(r);
  }));

  socket.on('queue:move', withRoom((r, me, { order }, ack) => {
    const res = r.moveItems(me, Array.isArray(order) ? order.map(String) : []);
    reply(ack, res);
    // Even on failure, resend so a stale drag snaps back to the real order.
    broadcastState(r);
  }));

  socket.on('queue:play', withRoom((r, me, { id }, ack) => {
    const res = r.playItem(me, String(id), Date.now());
    reply(ack, res);
    if (res.ok) broadcastState(r);
  }));

  socket.on('queue:skip', withRoom((r, me, ack) => {
    const res = r.skip(me, Date.now());
    reply(ack, res);
    if (res.ok) broadcastState(r);
  }));

  socket.on('queue:meta', withRoom((r, _me, meta) => {
    if (r.setMeta(String(meta.id), meta)) broadcastState(r);
  }));

  socket.on('chat:send', withRoom((r, me, { text, replyTo }, ack) => {
    if (!allow.chat(socket)) return denied(ack);
    const res = r.say(me, String(text ?? ''), replyTo ? String(replyTo) : undefined, Date.now());
    reply(ack, res.ok ? { ok: true } : res);
    if (res.ok) io.to(r.code).emit('chat:message', res.message);
  }));

  socket.on('chat:typing', withRoom((r, me) => {
    if (allow.typing(socket)) socket.to(r.code).emit('chat:typing', { id: me });
  }));

  socket.on('react', withRoom((r, me, { emoji }) => {
    if (!allow.react(socket) || !(REACTIONS as readonly string[]).includes(emoji)) return;
    const m = r.members.get(me)!;
    io.to(r.code).emit('react', { emoji, from: me, hue: m.hue });
  }));

  socket.on('member:rename', withRoom((r, me, { name }, ack) => {
    r.members.get(me)!.name = cleanName(name);
    reply(ack, { ok: true });
    broadcastState(r);
  }));

  socket.on('member:media', withRoom((r, me, { micOn, streams }) => {
    const m = r.members.get(me)!;
    if (typeof micOn === 'boolean') m.micOn = micOn;
    if (streams && typeof streams === 'object') {
      m.streams = {};
      if (typeof streams.voice === 'string') m.streams.voice = streams.voice.slice(0, 64);
      if (typeof streams.screen === 'string') m.streams.screen = streams.screen.slice(0, 64);
    }
    broadcastState(r);
  }));

  socket.on('host:transfer', withRoom((r, me, { id }, ack) => {
    const res = r.transferHost(me, String(id), Date.now());
    reply(ack, res);
    if (res.ok) broadcastState(r);
  }));

  socket.on('host:kick', withRoom((r, me, { id }, ack) => {
    if (!r.members.get(me)?.isHost) return reply(ack, { ok: false, code: 'forbidden', error: 'المضيف بس اللي يقدر يشيل حد.' });
    const target = r.members.get(String(id));
    if (!target || target.id === me) return reply(ack, { ok: false, code: 'invalid', error: 'الشخص ده مش في الغرفة.' });
    const targetSocket = target.socketId ? io.sockets.sockets.get(target.socketId) : undefined;
    r.remove(target.id, Date.now(), 'kicked');
    if (targetSocket) {
      targetSocket.emit('kicked');
      void targetSocket.leave(r.code);
    }
    reply(ack, { ok: true });
    broadcastState(r);
  }));

  socket.on('host:settings', withRoom((r, me, patch, ack) => {
    const res = r.updateSettings(me, patch ?? {});
    reply(ack, res);
    if (res.ok) broadcastState(r);
  }));

  socket.on('host:knock', withRoom((r, me, { id, accept }) => {
    if (!r.members.get(me)?.isHost) return;
    const knock = r.knocks.get(String(id));
    if (!knock) return;
    r.knocks.delete(String(id));
    const knocker = io.sockets.sockets.get(knock.socketId) as LotySocket | undefined;
    if (!knocker) return;
    if (!accept) {
      knocker.emit('knock:result', { accepted: false });
      return;
    }
    const can = r.canJoin();
    if (!can.ok) {
      knocker.emit('knock:result', { accepted: false });
      return;
    }
    const m = r.addMember(knock.name, knocker.id, Date.now());
    knocker.emit('knock:result', { accepted: true, session: { code: r.code, memberId: m.id, secret: m.secret } });
    // The knocker's own socket handler adopts the seat when it resumes with this session.
    broadcastState(r);
  }));

  socket.on('broadcast:start', withRoom((r, me, { label, from }, ack) => {
    const res = r.startBroadcast(me, String(label ?? ''), from === 'file' ? 'file' : 'screen', Date.now());
    ack(res);
    if (res.ok) broadcastState(r);
  }));

  socket.on('broadcast:stop', withRoom((r, me) => {
    r.endBroadcastsBy(me, Date.now());
    const m = r.members.get(me);
    if (m) delete m.streams.screen;
    broadcastState(r);
  }));

  // WebRTC signalling: relayed only between members of the same room.
  socket.on('rtc:signal', withRoom((r, me, { to, signal }) => {
    if (!allow.signal(socket)) return;
    const target = r.members.get(String(to));
    if (target?.socketId && signal && typeof signal === 'object') io.to(target.socketId).emit('rtc:signal', { from: me, signal });
  }));

  function cancelKnock() {
    if (knockId && knockRoom) {
      knockRoom.knocks.delete(knockId);
      const host = knockRoom.host();
      if (host?.socketId) io.to(host.socketId).emit('knock:cancel', { id: knockId });
    }
    knockId = null;
    knockRoom = null;
  }

  function leaveCurrent() {
    if (room && memberId) {
      const r = room;
      r.remove(memberId, Date.now(), 'left');
      void socket.leave(r.code);
      broadcastState(r);
    }
    room = null;
    memberId = null;
    cancelKnock();
  }

  socket.on('disconnect', () => {
    cancelKnock();
    if (room && memberId && room.members.get(memberId)?.socketId === socket.id) {
      room.disconnect(memberId, Date.now());
      if (room.evaluateHold(Date.now())) broadcastPlayback(room);
      broadcastState(room);
    }
  });
});

/**
 * Looks up real titles for the next few items that still carry a placeholder,
 * so the "now playing" line never says "untitled" for long.
 */
async function fillTitles(r: Room) {
  const todo = r.queue.filter((q) => (q.source.kind === 'youtube' || q.source.kind === 'vimeo') && isPlaceholderTitle(q.title)).slice(0, 12);
  if (todo.length === 0) return;
  let changed = false;
  await Promise.all(
    todo.map(async (q) => {
      const s = q.source as { kind: 'youtube' | 'vimeo'; id: string };
      const meta = await oembed(s.kind, s.id);
      if (meta.title && r.setMeta(q.id, { title: meta.title })) changed = true;
    }),
  );
  if (changed && rooms.get(r.code) === r) io.to(r.code).emit('room:state', r.snapshot());
}

function isNewItem(x: unknown): x is import('../shared/protocol.ts').NewItem {
  if (!x || typeof x !== 'object') return false;
  const s = (x as { source?: { kind?: unknown } }).source;
  if (!s || typeof s !== 'object') return false;
  switch (s.kind) {
    case 'youtube':
      return /^[A-Za-z0-9_-]{11}$/.test(String((s as { id?: unknown }).id));
    case 'vimeo':
      return /^\d{5,12}$/.test(String((s as { id?: unknown }).id));
    case 'direct': {
      const url = String((s as { url?: unknown }).url);
      return /^https?:\/\//i.test(url) && url.length < 2_000;
    }
    case 'local':
      return typeof (s as { name?: unknown }).name === 'string';
    default:
      // Broadcasts are created through broadcast:start, never through the queue.
      return false;
  }
}

// Housekeeping: release expired seats and forget empty rooms.
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (r.expireOffline(now)) io.to(code).emit('room:state', r.snapshot());
    if (r.emptySince !== null && now - r.emptySince > LIMITS.emptyRoomTtlMs) rooms.delete(code);
  }
}, 10_000).unref();

http.listen(PORT, () => {
  console.log(`Loty is listening on http://localhost:${PORT}`);
});
