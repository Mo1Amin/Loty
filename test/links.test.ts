import { describe, expect, it } from 'vitest';
import { parseLink, parseStart, titleFromUrl } from '../shared/links.ts';

const ID = 'dQw4w9WgXcQ';

function yt(input: string) {
  const r = parseLink(input);
  if (!r.ok) throw new Error(`rejected ${input}: ${r.reason}`);
  return r.link;
}

describe('YouTube links', () => {
  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?feature=share&v=${ID}`,
    `youtube.com/watch?v=${ID}`,
    `https://m.youtube.com/watch?v=${ID}&pp=ygU`,
    `https://music.youtube.com/watch?v=${ID}&si=abc`,
    `https://youtu.be/${ID}?si=xyz`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}?feature=shared`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
    `https://www.youtube.com/attribution_link?a=x&u=%2Fwatch%3Fv%3D${ID}%26feature%3Dshare`,
    ID,
  ])('%s', (input) => {
    expect(yt(input).source).toEqual({ kind: 'youtube', id: ID });
  });

  it('keeps the playlist when a video is opened from one, in any parameter order', () => {
    const link = yt(`https://www.youtube.com/watch?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG&index=4&v=${ID}`);
    expect(link.playlist).toEqual({ id: 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG', index: 3, personal: false, mix: false });
  });

  it('reports a playlist page with no video so the caller can expand it', () => {
    const r = parseLink('https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG');
    expect(r).toMatchObject({ ok: false, reason: 'playlist-only', playlist: { id: 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG' } });
  });

  it('flags mixes and personal lists', () => {
    expect(yt(`https://www.youtube.com/watch?v=${ID}&list=RD${ID}`).playlist?.mix).toBe(true);
    expect(yt(`https://www.youtube.com/watch?v=${ID}&list=WL`).playlist?.personal).toBe(true);
  });

  it('reads start times', () => {
    expect(yt(`https://youtu.be/${ID}?t=90`).startAt).toBe(90);
    expect(yt(`https://www.youtube.com/watch?v=${ID}&t=1m30s`).startAt).toBe(90);
    expect(yt(`https://www.youtube.com/embed/${ID}?start=42`).startAt).toBe(42);
  });

  it('rejects channel pages and broken ids', () => {
    expect(parseLink('https://www.youtube.com/@somechannel').ok).toBe(false);
    expect(parseLink('https://www.youtube.com/watch?v=short').ok).toBe(false);
  });
});

describe('Vimeo links', () => {
  it('public, unlisted and player URLs', () => {
    expect(yt('https://vimeo.com/76979871').source).toEqual({ kind: 'vimeo', id: '76979871' });
    expect(yt('https://vimeo.com/76979871/8272103f6e').source).toEqual({ kind: 'vimeo', id: '76979871', hash: '8272103f6e' });
    expect(yt('https://player.vimeo.com/video/76979871?h=8272103f6e').source).toEqual({ kind: 'vimeo', id: '76979871', hash: '8272103f6e' });
    expect(yt('https://vimeo.com/channels/staffpicks/76979871').source).toEqual({ kind: 'vimeo', id: '76979871' });
  });
});

describe('direct links', () => {
  it('detects video, audio and HLS', () => {
    expect(yt('https://cdn.example.com/a/movie.mp4?token=1').source).toMatchObject({ kind: 'direct', format: 'video' });
    expect(yt('https://cdn.example.com/live/index.m3u8').source).toMatchObject({ kind: 'direct', format: 'hls' });
    expect(yt('https://cdn.example.com/ep1.mp3').source).toMatchObject({ kind: 'direct', format: 'audio' });
  });

  it('refuses web pages and non-http schemes', () => {
    expect(parseLink('https://www.netflix.com/watch/123')).toEqual({ ok: false, reason: 'unsupported' });
    expect(parseLink('javascript:alert(1)').ok).toBe(false);
    expect(parseLink('file:///C:/a.mp4').ok).toBe(false);
  });

  it('names a file from its URL', () => {
    expect(titleFromUrl('https://x.com/media/My_Course-Lesson.01.mp4')).toBe('My Course Lesson 01');
  });
});

describe('parseStart', () => {
  it.each([
    ['90', 90], ['90s', 90], ['1h2m3s', 3723], ['2m', 120], ['', undefined], ['abc', undefined],
  ])('%s → %s', (input, expected) => expect(parseStart(input)).toBe(expected));
});
