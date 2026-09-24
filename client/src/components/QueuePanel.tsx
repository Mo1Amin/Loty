import { Reorder, useDragControls } from 'motion/react';
import { useEffect, useState } from 'react';
import type { QueueItem } from '../../../shared/protocol.ts';
import { formatTime } from '../../../shared/sync.ts';
import { youtubeThumb } from '../../../shared/links.ts';
import { client } from '../lib/room-client.ts';
import { toast, useClient } from '../lib/hooks.ts';
import { fetchTitles } from '../player/playlist.ts';
import { Icon, type IconName } from './Icon.tsx';

// Titles for playlist items are fetched lazily, once per id per session.
const titleCache = new Map<string, string | null>();
const pending = new Set<string>();
const listeners = new Set<() => void>();

function needsTitle(q: QueueItem) {
  return q.source.kind === 'youtube' && q.title.startsWith('فيديو ') && !titleCache.has(q.source.id);
}

async function resolveTitles(items: QueueItem[]) {
  const ids = items.filter(needsTitle).map((q) => (q.source as { id: string }).id).filter((id) => !pending.has(id));
  if (ids.length === 0) return;
  ids.forEach((id) => pending.add(id));
  const titles = await fetchTitles(ids);
  ids.forEach((id) => {
    titleCache.set(id, titles[id] ?? null);
    pending.delete(id);
  });
  listeners.forEach((fn) => fn());
}

function titleOf(q: QueueItem) {
  if (q.source.kind === 'youtube') return titleCache.get(q.source.id) ?? q.title;
  return q.title;
}

function thumbOf(q: QueueItem): string | null {
  if (q.source.kind === 'youtube') return youtubeThumb(q.source.id);
  return q.thumb ?? null;
}

function glyphOf(q: QueueItem): IconName {
  switch (q.source.kind) {
    case 'broadcast':
      return 'broadcast';
    case 'local':
      return 'file';
    case 'direct':
      return q.source.format === 'audio' ? 'wave' : 'film';
    default:
      return 'film';
  }
}

export function QueuePanel({ onAdd }: { onAdd: () => void }) {
  const { room } = useClient();
  const canControl = client.canControl;
  const queue = room?.queue ?? [];
  const playing = room?.playback.itemId ? queue[0] : undefined;
  const upcoming = playing ? queue.slice(1) : queue;
  const [order, setOrder] = useState(upcoming);
  const [, rerender] = useState(0);

  // Adopt the server's order whenever it changes (someone else reordered, or our move was refused).
  const key = upcoming.map((q) => q.id).join(',');
  useEffect(() => setOrder(upcoming), [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const fn = () => rerender((n) => n + 1);
    listeners.add(fn);
    void resolveTitles(queue.slice(0, 80));
    return () => {
      listeners.delete(fn);
    };
  }, [queue]);

  const commit = async () => {
    const ids = order.map((q) => q.id);
    if (ids.join(',') === key) return;
    const res = await client.move(ids);
    if (!res.ok) toast(res.error);
  };

  if (queue.length === 0) {
    return (
      <div className="side-body">
        <div className="empty">
          <Icon name="list" />
          <strong>القايمة فاضية</strong>
          ضيف فيديو أو بلاي ليست، والغرفة هتشغّلهم ورا بعض لوحدها.
          <button className="btn btn-filled btn-small" style={{ marginTop: 8 }} onClick={onAdd}>
            <Icon name="plus" size="sm" /> إضافة
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="side-body">
      {playing && (
        <>
          <div className="q-section">
            <span>شغّال دلوقتي</span>
            {canControl && (
              <button className="btn btn-plain" style={{ minHeight: 32 }} onClick={() => void client.skip()}>
                تخطّى <Icon name="forward" size="sm" />
              </button>
            )}
          </div>
          <ItemRow item={playing} current />
        </>
      )}
      {order.length > 0 && (
        <div className="q-section">
          <span>الجاي ({order.length})</span>
        </div>
      )}
      {!canControl && order.length > 0 && <p className="hint" style={{ margin: '0 16px 6px' }}>المضيف بس اللي يرتّب. تقدر تضيف لآخر القايمة.</p>}
      <Reorder.Group as="ol" axis="y" values={order} onReorder={setOrder} className="queue">
        {order.map((q) => (
          <DraggableRow key={q.id} item={q} canControl={canControl} onDrop={commit} />
        ))}
      </Reorder.Group>
    </div>
  );
}

function DraggableRow({ item, canControl, onDrop }: { item: QueueItem; canControl: boolean; onDrop: () => void }) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={item}
      dragListener={false}
      dragControls={controls}
      onDragEnd={onDrop}
      className="q-item"
      whileDrag={{ scale: 1.02, boxShadow: '0 12px 30px rgba(0,0,0,0.5)', zIndex: 5 }}
      transition={{ type: 'spring', bounce: 0, visualDuration: 0.3 }}
    >
      <ItemBody item={item} onPlay={canControl ? () => void client.playItem(item.id) : undefined} />
      {canControl && (
        <>
          <button className="icon-btn" onClick={() => void client.remove(item.id)} aria-label={`شيل ${titleOf(item)}`}>
            <Icon name="trash" size="sm" />
          </button>
          <span className="q-grip" onPointerDown={(e) => controls.start(e)} aria-hidden>
            <Icon name="grip" />
          </span>
        </>
      )}
    </Reorder.Item>
  );
}

function ItemRow({ item, current }: { item: QueueItem; current?: boolean }) {
  return (
    <div className={`q-item${current ? ' current' : ''}`}>
      <ItemBody item={item} current={current} />
    </div>
  );
}

function ItemBody({ item, current, onPlay }: { item: QueueItem; current?: boolean; onPlay?: () => void }) {
  const thumb = thumbOf(item);
  const content = (
    <>
      <span className="q-thumb">
        {thumb ? <img src={thumb} alt="" loading="lazy" /> : <Icon name={glyphOf(item)} />}
        {item.duration ? <span className="q-dur">{formatTime(item.duration)}</span> : null}
      </span>
      <span className="q-text">
        <span className="q-title">
          <bdi>{titleOf(item)}</bdi>
        </span>
        <span className="q-sub" style={{ display: 'block' }}>
          {current ? <span className="q-now">شغّال · </span> : null}
          ضافه {item.addedBy}
        </span>
      </span>
    </>
  );
  if (!onPlay) return <span style={{ display: 'contents' }}>{content}</span>;
  return (
    <button className="q-item-main" onClick={onPlay} style={{ display: 'contents' }} aria-label={`شغّل ${titleOf(item)} دلوقتي`}>
      {content}
    </button>
  );
}

