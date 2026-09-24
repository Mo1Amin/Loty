import type { YouTubePlaylist } from '../../../shared/links.ts';
import { loadYouTubeApi } from './youtube.ts';

export type ExpandResult =
  | { ok: true; ids: string[]; startIndex: number }
  | { ok: false; reason: 'personal' | 'unavailable' | 'timeout' };

/**
 * Reads the video ids of a YouTube playlist without an API key, by cueing it in
 * a hidden player and asking for `getPlaylist()`.
 *
 * Why expand at all: when every member's embed walks the playlist on its own,
 * one skipped ad or unavailable video puts people on different videos. Turning
 * the list into the room's queue gives the whole room one "current video".
 */
export async function expandPlaylist(list: YouTubePlaylist, anchorVideoId?: string): Promise<ExpandResult> {
  if (list.personal) return { ok: false, reason: 'personal' };
  const api = await loadYouTubeApi();

  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;width:1px;height:1px;left:-10px;top:-10px;opacity:0;pointer-events:none';
  const mount = document.createElement('div');
  box.appendChild(mount);
  document.body.appendChild(box);

  let player: YT.Player | null = null;
  try {
    const ids = await new Promise<string[] | null>((resolve) => {
      const timeout = window.setTimeout(() => resolve(null), 12_000);
      player = new api.Player(mount, {
        width: 1,
        height: 1,
        playerVars: { listType: 'playlist', list: list.id, origin: location.origin, autoplay: 0, mute: 1 } as YT.PlayerVars,
        events: {
          onReady: (e) => {
            const poll = (tries: number) => {
              const got = e.target.getPlaylist();
              if (got && got.length > 0) {
                window.clearTimeout(timeout);
                resolve(got);
              } else if (tries > 0) window.setTimeout(() => poll(tries - 1), 300);
            };
            poll(30);
          },
          onError: () => {
            window.clearTimeout(timeout);
            resolve([]);
          },
        },
      });
    });
    if (ids === null) return { ok: false, reason: 'timeout' };
    if (ids.length === 0) return { ok: false, reason: 'unavailable' };
    let startIndex = list.index ?? 0;
    if (anchorVideoId) {
      const at = ids.indexOf(anchorVideoId);
      if (at >= 0) startIndex = at;
    }
    return { ok: true, ids, startIndex: Math.min(startIndex, ids.length - 1) };
  } finally {
    try {
      (player as YT.Player | null)?.destroy();
    } catch {
      /* not created */
    }
    box.remove();
  }
}

/** Titles for up to 60 ids per call, from the server's oEmbed cache. */
export async function fetchTitles(ids: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (let i = 0; i < ids.length; i += 60) {
    try {
      const res = await fetch('/api/meta/youtube', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: ids.slice(i, i + 60) }),
      });
      if (res.ok) Object.assign(out, ((await res.json()) as { titles: Record<string, string | null> }).titles);
    } catch {
      /* titles fill in later from each player */
    }
  }
  return out;
}

export async function fetchMeta(kind: 'youtube' | 'vimeo', id: string): Promise<{ title: string | null; thumb: string | null }> {
  try {
    const res = await fetch(`/api/meta/${kind}/${id}`);
    if (res.ok) return (await res.json()) as { title: string | null; thumb: string | null };
  } catch {
    /* offline */
  }
  return { title: null, thumb: null };
}
