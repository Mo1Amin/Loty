import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ChatMessage, Member } from '../../../shared/protocol.ts';
import { parseLink } from '../../../shared/links.ts';
import { parseClock } from '../../../shared/sync.ts';
import { client } from '../lib/room-client.ts';
import { useClient } from '../lib/hooks.ts';
import { Avatar } from './ui.tsx';
import { Icon } from './Icon.tsx';

const TOKEN = /(https?:\/\/[^\s]+|\b\d{1,2}:\d{2}(?::\d{2})?\b)/g;

function renderText(text: string, onSeek: (t: number) => void, onAddLink: (url: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const token = m[0];
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const seconds = parseClock(token);
    if (seconds !== null) {
      out.push(
        <button key={at} className="time-link" onClick={(e) => { e.stopPropagation(); onSeek(seconds); }} title="روح للّحظة دي">
          {token}
        </button>,
      );
    } else {
      const playable = parseLink(token);
      out.push(
        <span key={at}>
          <a className="time-link" href={token} target="_blank" rel="noopener noreferrer" dir="ltr" onClick={(e) => e.stopPropagation()}>
            {token.length > 42 ? `${token.slice(0, 40)}…` : token}
          </a>
          {(playable.ok || playable.reason === 'playlist-only') && (
            <>
              {' '}
              <button className="time-link" onClick={(e) => { e.stopPropagation(); onAddLink(token); }}>
                ضيفه
              </button>
            </>
          )}
        </span>,
      );
    }
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function ChatPanel({ onSeek, onAddLink, speaking }: { onSeek: (t: number) => void; onAddLink: (url: string) => void; speaking: ReadonlySet<string> }) {
  const { room, me, typing } = useClient();
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const chat = room?.chat ?? [];
  const members = useMemo(() => new Map<string, Member>((room?.members ?? []).map((m) => [m.id, m])), [room?.members]);

  // Stay pinned to the newest message unless the reader scrolled up.
  useLayoutEffect(() => {
    const el = listRef.current?.parentElement;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat.length]);
  useEffect(() => {
    const el = listRef.current?.parentElement;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const [, force] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => force((n) => n + 1), 1_000);
    return () => window.clearInterval(t);
  }, []);
  const typers = Object.entries(typing)
    .filter(([id, at]) => id !== me && Date.now() - at < 3_500)
    .map(([id]) => members.get(id)?.name)
    .filter(Boolean) as string[];

  return (
    <>
      <div className="side-body">
        <div className="chat-list" ref={listRef}>
          {chat.length === 0 && (
            <div className="empty">
              <Icon name="chat" />
              <strong>قولوا حاجة</strong>
              اكتب وقت زي 12:34 وهيبقى زرار ينقل الكل للّحظة دي.
            </div>
          )}
          {chat.map((m, i) => {
            if (!m.from) return <div key={m.id} className="notice">{m.text}</div>;
            const prev = chat[i - 1];
            const next = chat[i + 1];
            const startsGroup = !prev || prev.from !== m.from || m.at - prev.at > 120_000;
            const endsGroup = !next || next.from !== m.from || next.at - m.at > 120_000;
            const mine = m.from === me;
            return (
              <div
                key={m.id}
                className={`msg ${mine ? 'mine' : 'theirs'}${startsGroup ? ' msg-group-start' : ''}`}
                onDoubleClick={() => setReplyTo(m)}
              >
                {!mine && (endsGroup ? <Avatar name={m.name} hue={m.hue} size={26} speaking={speaking.has(m.from)} /> : <span className="msg-spacer" />)}
                <div className="bubble" style={{ ['--hue' as string]: m.hue }}>
                  {!mine && startsGroup && <span className="bubble-name">{m.name}</span>}
                  {m.replyTo && (
                    <span className="bubble-reply">
                      {m.replyTo.name}: {m.replyTo.text}
                    </span>
                  )}
                  {renderText(m.text, onSeek, onAddLink)}
                </div>
                <button className="icon-btn" style={{ width: 28, height: 28, color: 'var(--label-3)' }} onClick={() => setReplyTo(m)} aria-label={`رد على ${m.name}`}>
                  <Icon name="reply" size="sm" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
      <div className="typing" aria-live="polite">
        {typers.length === 1 ? `${typers[0]} بيكتب…` : typers.length > 1 ? `${typers.length} بيكتبوا…` : ''}
      </div>
      <Composer replyTo={replyTo} onClearReply={() => setReplyTo(null)} />
    </>
  );
}

function Composer({ replyTo, onClearReply }: { replyTo: ChatMessage | null; onClearReply: () => void }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);

  useEffect(() => {
    if (replyTo) ref.current?.focus();
  }, [replyTo]);

  const autosize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(120, el.scrollHeight)}px`;
  };

  const send = async () => {
    const value = text.trim();
    if (!value) return;
    setText('');
    requestAnimationFrame(autosize);
    onClearReply();
    const res = await client.say(value, replyTo?.id);
    if (!res.ok) setText(value); // give it back rather than lose it
  };

  return (
    <>
      {replyTo && (
        <div className="reply-bar">
          <Icon name="reply" size="sm" />
          <span>
            رد على {replyTo.name}: {replyTo.text}
          </span>
          <button className="icon-btn" style={{ width: 32, height: 32 }} onClick={onClearReply} aria-label="إلغاء الرد">
            <Icon name="close" size="sm" />
          </button>
        </div>
      )}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label className="visually-hidden" htmlFor="composer">رسالة</label>
        <textarea
          id="composer"
          ref={ref}
          className="composer-input"
          rows={1}
          placeholder="رسالة"
          maxLength={500}
          enterKeyHint="send"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            autosize();
            if (Date.now() - lastTyping.current > 2_000) {
              lastTyping.current = Date.now();
              client.typing();
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="send-btn" type="submit" disabled={!text.trim()} aria-label="إرسال">
          <Icon name="send" size="sm" />
        </button>
      </form>
    </>
  );
}
