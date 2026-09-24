import type { MediaSource } from './protocol.ts';

// Turns whatever someone pastes into something a player can open.
// The old version matched one regex against `watch?v=`; it lost `list=`,
// failed when `v` was not the first parameter, and rejected playlist pages.

export interface ParsedLink {
  source: MediaSource;
  /** Seconds, from `t=`, `start=` or `#t=`. */
  startAt?: number;
  /** Present when the link belongs to a YouTube playlist or mix. */
  playlist?: YouTubePlaylist;
}

export interface YouTubePlaylist {
  id: string;
  /** Zero-based position of the linked video inside the list, when known. */
  index?: number;
  /** Personal lists (Watch later, Liked) are private and cannot be embedded. */
  personal: boolean;
  /** Auto-generated mixes (RD…) change per viewer and often refuse to load in embeds. */
  mix: boolean;
}

export type LinkResult =
  | { ok: true; link: ParsedLink }
  | { ok: false; reason: 'empty' | 'unsupported' | 'playlist-only'; playlist?: YouTubePlaylist };

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'gaming.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
  'www.youtu.be',
]);
const VIDEO_EXT = /\.(mp4|m4v|webm|ogv|mov|mkv)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i;
const HLS_EXT = /\.m3u8$/i;

export function parseLink(input: string): LinkResult {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: 'empty' };

  if (YT_ID.test(raw)) return { ok: true, link: { source: { kind: 'youtube', id: raw } } };

  const url = toUrl(raw);
  if (!url) return { ok: false, reason: 'unsupported' };

  const host = url.hostname.toLowerCase();
  if (YT_HOSTS.has(host)) return parseYouTube(url);
  if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) return parseVimeo(url);
  return parseDirect(url);
}

function toUrl(raw: string): URL | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
    return url;
  } catch {
    return null;
  }
}

function parseYouTube(url: URL): LinkResult {
  // Links shared from the app sometimes wrap the real path: /attribution_link?u=/watch%3Fv%3D…
  const wrapped = url.searchParams.get('u');
  if (url.pathname === '/attribution_link' && wrapped) {
    return parseYouTube(new URL(wrapped, 'https://www.youtube.com'));
  }

  const params = url.searchParams;
  const segments = url.pathname.split('/').filter(Boolean);
  let id: string | null = null;

  if (url.hostname.endsWith('youtu.be')) {
    id = segments[0] ?? null;
  } else if (segments[0] === 'watch') {
    id = params.get('v');
  } else if (segments[0] && ['embed', 'shorts', 'live', 'v', 'e'].includes(segments[0])) {
    id = segments[1] ?? null;
  }
  if (id && !YT_ID.test(id)) id = null;

  const listId = params.get('list');
  const playlist = listId && /^[A-Za-z0-9_-]{2,64}$/.test(listId) ? describePlaylist(listId, params) : undefined;
  const startAt = parseStart(params.get('t') ?? params.get('start') ?? url.hash.replace(/^#t=/, ''));

  if (!id) {
    // youtube.com/playlist?list=… has no video of its own; the caller expands it.
    if (playlist) return { ok: false, reason: 'playlist-only', playlist };
    return { ok: false, reason: 'unsupported' };
  }
  const link: ParsedLink = { source: { kind: 'youtube', id } };
  if (startAt) link.startAt = startAt;
  if (playlist) link.playlist = playlist;
  return { ok: true, link };
}

function describePlaylist(id: string, params: URLSearchParams): YouTubePlaylist {
  const indexParam = Number(params.get('index'));
  const playlist: YouTubePlaylist = {
    id,
    personal: id === 'WL' || id === 'LL' || id === 'LM',
    mix: id.startsWith('RD'),
  };
  // YouTube's `index` is one-based in watch URLs.
  if (Number.isInteger(indexParam) && indexParam > 0) playlist.index = indexParam - 1;
  return playlist;
}

function parseVimeo(url: URL): LinkResult {
  const segments = url.pathname.split('/').filter(Boolean);
  const numericAt = segments.findIndex((s) => /^\d{5,12}$/.test(s));
  if (numericAt < 0) return { ok: false, reason: 'unsupported' };
  const id = segments[numericAt]!;
  // Unlisted videos carry a privacy hash either as the next segment or as ?h=
  const next = segments[numericAt + 1];
  const hash = url.searchParams.get('h') ?? (next && /^[0-9a-f]{6,20}$/i.test(next) ? next : undefined);
  const source: MediaSource = hash ? { kind: 'vimeo', id, hash } : { kind: 'vimeo', id };
  const startAt = parseStart(url.hash.replace(/^#t=/, ''));
  return { ok: true, link: startAt ? { source, startAt } : { source } };
}

function parseDirect(url: URL): LinkResult {
  const path = decodeURIComponent(url.pathname);
  let format: 'video' | 'hls' | 'audio' | null = null;
  if (HLS_EXT.test(path)) format = 'hls';
  else if (VIDEO_EXT.test(path)) format = 'video';
  else if (AUDIO_EXT.test(path)) format = 'audio';
  if (!format) return { ok: false, reason: 'unsupported' };
  return { ok: true, link: { source: { kind: 'direct', url: url.toString(), format } } };
}

/** "90", "90s", "1m30s", "1h2m3s" → seconds */
export function parseStart(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  if (/^\d+(\.\d+)?s?$/.test(value)) return Number.parseFloat(value) || undefined;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  if (!m || value === '') return undefined;
  const total = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return total || undefined;
}

/** A readable name for a direct link: the file name without its extension. */
export function titleFromUrl(url: string): string {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    return last.replace(/\.[a-z0-9]+$/i, '').replace(/[._-]+/g, ' ').trim() || new URL(url).hostname;
  } catch {
    return url;
  }
}

export function youtubeThumb(id: string): string {
  return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
}
