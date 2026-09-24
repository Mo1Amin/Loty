import type { Request, Response, Router } from 'express';
import express from 'express';

// Small HTTP helpers the client cannot do itself: YouTube and Vimeo titles
// (oEmbed needs no API key but sends no CORS headers), and thumbnail bytes
// for the ambient light (a canvas cannot read pixels from another origin).

const TITLE_TTL = 6 * 60 * 60_000;
const titles = new Map<string, { at: number; title: string | null; thumb?: string | undefined }>();

/** Only these hosts may be fetched through the image proxy. Anything else is an open proxy waiting to happen. */
const IMAGE_HOSTS = new Set(['i.ytimg.com', 'img.youtube.com', 'i.vimeocdn.com']);

async function fetchJson(url: string, timeoutMs = 5_000): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'Loty/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function oembed(kind: 'youtube' | 'vimeo', id: string): Promise<{ title: string | null; thumb?: string | undefined }> {
  const key = `${kind}:${id}`;
  const cached = titles.get(key);
  if (cached && Date.now() - cached.at < TITLE_TTL) return cached;
  const target =
    kind === 'youtube'
      ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`
      : `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${id}`)}`;
  let entry: { at: number; title: string | null; thumb?: string | undefined };
  try {
    const data = (await fetchJson(target)) as { title?: unknown; thumbnail_url?: unknown };
    entry = {
      at: Date.now(),
      title: typeof data.title === 'string' ? data.title : null,
      thumb: typeof data.thumbnail_url === 'string' ? data.thumbnail_url : undefined,
    };
  } catch {
    // Private, deleted or not embeddable. Remember briefly so a big playlist does not hammer oEmbed.
    entry = { at: Date.now() - TITLE_TTL + 60_000, title: null };
  }
  titles.set(key, entry);
  if (titles.size > 5_000) titles.delete(titles.keys().next().value!);
  return entry;
}

/** Runs `fn` over `items` with at most `limit` in flight. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** STUN plus any fixed TURN relay from the environment. */
export function staticIceServers(env: NodeJS.ProcessEnv = process.env): RTCIceServer[] {
  // Full control: ICE_SERVERS='[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]'
  if (env.ICE_SERVERS) {
    try {
      const parsed = JSON.parse(env.ICE_SERVERS) as RTCIceServer[];
      if (Array.isArray(parsed)) return parsed;
    } catch {
      console.warn('ICE_SERVERS is not valid JSON; falling back to STUN only');
    }
  }
  const servers: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  // Most phones on mobile data sit behind carrier NAT, where STUN alone fails. A TURN relay fixes that.
  if (env.TURN_URL) {
    servers.push({
      urls: env.TURN_URL.split(',').map((u) => u.trim()),
      username: env.TURN_USERNAME ?? '',
      credential: env.TURN_CREDENTIAL ?? '',
    });
  }
  return servers;
}

// Cloudflare TURN hands out short-lived credentials through an API instead of a fixed
// password, so the server asks for a set that lasts a day and reuses it for half of that.
const CF_TTL_S = 24 * 60 * 60;
let cfCache: { servers: RTCIceServer[]; until: number } | null = null;
let cfPending: Promise<RTCIceServer[] | null> | null = null;

async function cloudflareIceServers(env: NodeJS.ProcessEnv, fetcher: typeof fetch): Promise<RTCIceServer[] | null> {
  const keyId = env.CF_TURN_KEY_ID;
  const token = env.CF_TURN_API_TOKEN;
  if (!keyId || !token) return null;
  if (cfCache && Date.now() < cfCache.until) return cfCache.servers;
  cfPending ??= (async () => {
    try {
      const res = await fetcher(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl: CF_TTL_S }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`Cloudflare TURN answered ${res.status}`);
      const data = (await res.json()) as { iceServers?: RTCIceServer[] };
      if (!Array.isArray(data.iceServers) || data.iceServers.length === 0) throw new Error('Cloudflare TURN sent no servers');
      cfCache = { servers: data.iceServers, until: Date.now() + (CF_TTL_S * 1000) / 2 };
      return data.iceServers;
    } catch (err) {
      // A stale set is better than none while Cloudflare is unreachable.
      console.warn('Cloudflare TURN credentials failed:', (err as Error).message);
      return cfCache?.servers ?? null;
    } finally {
      cfPending = null;
    }
  })();
  return cfPending;
}

export async function iceServers(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): Promise<RTCIceServer[]> {
  const fixed = staticIceServers(env);
  const cloudflare = await cloudflareIceServers(env, fetcher);
  return cloudflare ? [...fixed, ...cloudflare] : fixed;
}

/** For tests. */
export function resetIceCache() {
  cfCache = null;
  cfPending = null;
}

export function metaRouter(): Router {
  const router = express.Router();

  router.get('/meta/:kind/:id', async (req: Request, res: Response) => {
    const kind = req.params.kind;
    const id = String(req.params.id);
    if ((kind !== 'youtube' && kind !== 'vimeo') || !/^[A-Za-z0-9_-]{5,20}$/.test(id)) {
      res.status(400).json({ error: 'bad id' });
      return;
    }
    const data = await oembed(kind, id);
    res.set('cache-control', 'public, max-age=3600').json({ title: data.title, thumb: data.thumb ?? null });
  });

  // Titles for a whole expanded playlist in one round trip.
  router.post('/meta/youtube', express.json({ limit: '32kb' }), async (req: Request, res: Response) => {
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{11}$/.test(x)).slice(0, 60) : [];
    const results = await pool(ids, 6, async (id) => [id, (await oembed('youtube', id)).title] as const);
    res.json({ titles: Object.fromEntries(results) });
  });

  router.get('/img', async (req: Request, res: Response) => {
    let url: URL;
    try {
      url = new URL(String(req.query.u ?? ''));
    } catch {
      res.status(400).end();
      return;
    }
    if (url.protocol !== 'https:' || !IMAGE_HOSTS.has(url.hostname)) {
      res.status(403).end();
      return;
    }
    try {
      const upstream = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
      const type = upstream.headers.get('content-type') ?? '';
      if (!upstream.ok || !type.startsWith('image/')) {
        res.status(502).end();
        return;
      }
      const body = Buffer.from(await upstream.arrayBuffer());
      if (body.length > 2_000_000) {
        res.status(502).end();
        return;
      }
      res.set({ 'content-type': type, 'cache-control': 'public, max-age=86400' }).send(body);
    } catch {
      res.status(504).end();
    }
  });

  router.get('/ice', async (_req, res) => {
    res.set('cache-control', 'no-store').json({ iceServers: await iceServers() });
  });

  return router;
}
