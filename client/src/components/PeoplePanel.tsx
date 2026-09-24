import { useState } from 'react';
import type { Member } from '../../../shared/protocol.ts';
import { client } from '../lib/room-client.ts';
import { toast, useClient } from '../lib/hooks.ts';
import { Icon } from './Icon.tsx';
import { Sheet } from './Sheet.tsx';
import { Avatar } from './ui.tsx';

export function PeoplePanel({ speaking, onInvite }: { speaking: ReadonlySet<string>; onInvite: () => void }) {
  const { room, me } = useClient();
  const [selected, setSelected] = useState<Member | null>(null);
  const iAmHost = !!room?.members.find((m) => m.id === me)?.isHost;
  if (!room) return null;

  return (
    <div className="side-body">
      <div className="people">
        <div className="group">
          {room.members.map((m) => {
            const tags: string[] = [];
            if (!m.online) tags.push('بيرجع…');
            if (m.buffering) tags.push('بيحمّل');
            if (m.streams.screen) tags.push('بيبث');
            const canManage = iAmHost && m.id !== me;
            const Tag = canManage ? 'button' : 'div';
            return (
              <Tag key={m.id} className="row" {...(canManage ? { type: 'button' as const, onClick: () => setSelected(m) } : {})}>
                <Avatar name={m.name} hue={m.hue} size={30} speaking={speaking.has(m.id)} offline={!m.online} />
                <span className="row-text">
                  <span className="row-title">
                    {m.name}
                    {m.id === me && <span style={{ color: 'var(--label-2)' }}> (انت)</span>}{' '}
                    {m.isHost && (
                      <span className="badge host">
                        <Icon name="crown" size="sm" /> المضيف
                      </span>
                    )}
                  </span>
                  {tags.length > 0 && <span className="row-sub" style={{ display: 'block' }}>{tags.join('، ')}</span>}
                </span>
                {m.micOn && (
                  <span className="row-end" aria-label="المايك مفتوح">
                    <Icon name="mic" size="sm" />
                  </span>
                )}
              </Tag>
            );
          })}
        </div>
        <p className="group-note">لحد {12} شخص في الغرفة.</p>
        <div className="group" style={{ marginTop: 20 }}>
          <button className="row" onClick={onInvite}>
            <span className="row-icon" style={{ background: 'var(--tint)' }}>
              <Icon name="link" size="sm" />
            </span>
            <span className="row-text row-title" style={{ color: 'var(--tint)' }}>
              ادعي حد
            </span>
          </button>
        </div>
      </div>

      <Sheet open={!!selected} onClose={() => setSelected(null)} title={selected?.name ?? ''}>
        {selected && (
          <div className="group" style={{ marginTop: 8 }}>
            <button
              className="row"
              onClick={async () => {
                const res = await client.transferHost(selected.id);
                if (!res.ok) toast(res.error);
                setSelected(null);
              }}
            >
              <span className="row-icon" style={{ background: '#ff9f0a' }}>
                <Icon name="crown" size="sm" />
              </span>
              <span className="row-text row-title">خليه المضيف</span>
            </button>
            <button
              className="row"
              onClick={async () => {
                const res = await client.kick(selected.id);
                if (!res.ok) toast(res.error);
                setSelected(null);
              }}
            >
              <span className="row-icon" style={{ background: 'var(--live)' }}>
                <Icon name="leave" size="sm" />
              </span>
              <span className="row-text row-title" style={{ color: 'var(--live)' }}>
                اشيله من الغرفة
              </span>
            </button>
          </div>
        )}
      </Sheet>
    </div>
  );
}
