import { beforeEach, describe, expect, it, vi } from 'vitest';
import { iceServers, resetIceCache } from '../server/meta.ts';

const cfAnswer = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' },
  ],
};
const ok = () => new Response(JSON.stringify(cfAnswer), { status: 201 });

describe('ICE servers', () => {
  beforeEach(() => resetIceCache());

  it('is STUN only with nothing configured', async () => {
    const servers = await iceServers({}, vi.fn());
    expect(servers).toHaveLength(1);
    expect(JSON.stringify(servers)).not.toContain('turn:');
  });

  it('adds a fixed TURN relay', async () => {
    const servers = await iceServers({ TURN_URL: 'turn:a:3478, turns:a:5349', TURN_USERNAME: 'x', TURN_CREDENTIAL: 'y' }, vi.fn());
    expect(servers[1]).toEqual({ urls: ['turn:a:3478', 'turns:a:5349'], username: 'x', credential: 'y' });
  });

  it('asks Cloudflare once, with the key and token, and reuses the answer', async () => {
    const fetcher = vi.fn(async () => ok());
    const env = { CF_TURN_KEY_ID: 'key', CF_TURN_API_TOKEN: 'tok' };
    const first = await iceServers(env, fetcher as unknown as typeof fetch);
    await iceServers(env, fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/key/credentials/generate-ice-servers');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.stringify(first)).toContain('turn.cloudflare.com');
  });

  it('falls back to STUN when Cloudflare refuses', async () => {
    const fetcher = vi.fn(async () => new Response('no', { status: 401 }));
    const servers = await iceServers({ CF_TURN_KEY_ID: 'k', CF_TURN_API_TOKEN: 'bad' }, fetcher as unknown as typeof fetch);
    expect(servers).toHaveLength(1);
  });
});
