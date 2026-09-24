export interface PlayerEvents {
  play(): void;
  pause(): void;
  /** Only raised by players that report seeks themselves (HTML5, Vimeo). */
  seeked(time: number): void;
  buffering(on: boolean): void;
  ended(): void;
  error(error: PlayerError): void;
  meta(meta: { title?: string; duration?: number }): void;
}

export interface PlayerError {
  /** Short, actionable text for people, not a code. */
  message: string;
  /** The owner blocked playback outside their site. Broadcasting the tab still works. */
  embedBlocked?: boolean;
  openUrl?: string;
}

export interface Player {
  /** Whether small drift can be closed by nudging the speed instead of seeking. */
  readonly smooth: boolean;
  /** Live streams and broadcasts cannot be seeked or paused for the room. */
  readonly live: boolean;
  /** Present when the pixels are readable, for the ambient light. */
  readonly video?: HTMLVideoElement;
  /** Resolves false when the browser blocked playback with sound. */
  play(): Promise<boolean>;
  pause(): void;
  seek(time: number): void;
  setRate(rate: number): void;
  getTime(): number;
  getDuration(): number;
  isPlaying(): boolean;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  destroy(): void;
}

export const noopEvents: PlayerEvents = {
  play() {},
  pause() {},
  seeked() {},
  buffering() {},
  ended() {},
  error() {},
  meta() {},
};
