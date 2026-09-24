import type { RtcSignal } from '../../../shared/protocol.ts';

type Kind = 'voice' | 'screen';

interface Peer {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  senders: Map<string, RTCRtpSender>; // track id → sender
}

let iceCache: Promise<RTCIceServer[]> | null = null;
function iceServers(): Promise<RTCIceServer[]> {
  iceCache ??= fetch('/api/ice')
    .then((r) => r.json() as Promise<{ iceServers: RTCIceServer[] }>)
    .then((d) => d.iceServers)
    .catch(() => [{ urls: 'stun:stun.l.google.com:19302' }]);
  return iceCache;
}

/**
 * A full mesh between the people in a room. One connection per pair carries
 * everything — voice both ways, a broadcast one way — and renegotiates by
 * itself when a track is added or removed ("perfect negotiation").
 *
 * A mesh is right for a watch party: no media server to run, and rooms are
 * small. The cost is upload: a broadcaster sends one copy per viewer, so a
 * screen broadcast is comfortable for about five viewers on home internet.
 */
export class Mesh {
  private peers = new Map<string, Peer>();
  private local: Partial<Record<Kind, MediaStream>> = {};
  private members: string[] = [];
  private readonly me: string;
  private readonly send: (to: string, signal: RtcSignal) => void;
  /** Every remote stream by id; the room state says which member and kind each id is. */
  readonly remote = new Map<string, { from: string; stream: MediaStream }>();
  private listeners = new Set<() => void>();
  version = 0;

  constructor(me: string, send: (to: string, signal: RtcSignal) => void) {
    this.me = me;
    this.send = send;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  private changed() {
    this.version++;
    this.listeners.forEach((fn) => fn());
  }

  streamById(id: string | undefined): MediaStream | null {
    return id ? this.remote.get(id)?.stream ?? null : null;
  }

  /** Online member ids other than me. Connects to newcomers when there is something to send. */
  async setMembers(ids: string[]) {
    this.members = ids.filter((id) => id !== this.me);
    for (const [id, peer] of this.peers) {
      if (!this.members.includes(id)) this.closePeer(id, peer);
    }
    if (this.hasLocal()) for (const id of this.members) await this.ensurePeer(id);
  }

  async setLocal(kind: Kind, stream: MediaStream | null) {
    const old = this.local[kind];
    if (old === stream) return;
    if (stream) this.local[kind] = stream;
    else delete this.local[kind];

    for (const id of this.members) {
      const peer = stream ? await this.ensurePeer(id) : this.peers.get(id);
      if (!peer) continue;
      if (old) {
        for (const track of old.getTracks()) {
          const sender = peer.senders.get(track.id);
          if (sender) {
            try {
              peer.pc.removeTrack(sender);
            } catch {
              /* connection already closed */
            }
            peer.senders.delete(track.id);
          }
        }
      }
      if (stream) this.addStream(peer, stream, kind);
    }
  }

  /** A local stream gained tracks after it was shared (a captured <video> starting up). */
  resync() {
    for (const peer of this.peers.values()) {
      for (const [kind, stream] of Object.entries(this.local) as [Kind, MediaStream][]) this.addStream(peer, stream, kind);
    }
  }

  private hasLocal() {
    return Object.values(this.local).some(Boolean);
  }

  private addStream(peer: Peer, stream: MediaStream, kind: Kind) {
    for (const track of stream.getTracks()) {
      if (peer.senders.has(track.id)) continue;
      const sender = peer.pc.addTrack(track, stream);
      peer.senders.set(track.id, sender);
      if (kind === 'screen' && track.kind === 'video') void tuneVideoSender(sender);
    }
  }

  private async ensurePeer(id: string): Promise<Peer> {
    const existing = this.peers.get(id);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: await iceServers() });
    // Re-check: another call may have created it while we awaited the ICE list.
    const raced = this.peers.get(id);
    if (raced) {
      pc.close();
      return raced;
    }
    const peer: Peer = { pc, polite: this.me > id, makingOffer: false, ignoreOffer: false, senders: new Map() };
    this.peers.set(id, peer);

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) this.send(id, { description: pc.localDescription.toJSON() });
      } catch (err) {
        console.warn('offer failed', err);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => this.send(id, { candidate: candidate ? candidate.toJSON() : null });
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') pc.restartIce();
    };
    pc.ontrack = ({ track, streams }) => {
      const stream = streams[0] ?? new MediaStream([track]);
      this.remote.set(stream.id, { from: id, stream });
      const drop = () => {
        // A muted track is only starved for data; the stream is gone when no live track is left.
        if (stream.getTracks().every((t) => t.readyState === 'ended')) {
          this.remote.delete(stream.id);
          this.changed();
        }
      };
      stream.onremovetrack = drop;
      track.onended = drop;
      this.changed();
    };

    for (const [kind, stream] of Object.entries(this.local) as [Kind, MediaStream][]) this.addStream(peer, stream, kind);
    return peer;
  }

  async handleSignal(from: string, signal: RtcSignal) {
    const peer = await this.ensurePeer(from);
    const pc = peer.pc;
    try {
      if ('description' in signal) {
        const description = signal.description;
        const collision = description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          if (pc.localDescription) this.send(from, { description: pc.localDescription.toJSON() });
        }
      } else if (signal.candidate) {
        try {
          await pc.addIceCandidate(signal.candidate);
        } catch (err) {
          if (!peer.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.warn('signal failed', err);
    }
  }

  private closePeer(id: string, peer: Peer) {
    peer.pc.close();
    this.peers.delete(id);
    for (const [sid, r] of this.remote) if (r.from === id) this.remote.delete(sid);
    this.changed();
  }

  destroy() {
    for (const [id, peer] of this.peers) this.closePeer(id, peer);
    this.listeners.clear();
  }
}

async function tuneVideoSender(sender: RTCRtpSender) {
  // Films, not slides: keep the frame rate and let resolution give way on a weak uplink.
  if (sender.track && 'contentHint' in sender.track) sender.track.contentHint = 'motion';
  try {
    const params = sender.getParameters();
    params.encodings = params.encodings?.length ? params.encodings : [{}];
    params.encodings[0]!.maxBitrate = 2_500_000;
    params.encodings[0]!.maxFramerate = 30;
    (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference = 'maintain-framerate';
    await sender.setParameters(params);
  } catch {
    /* some browsers refuse before negotiation; defaults are fine */
  }
}
