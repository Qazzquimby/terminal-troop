import type { PeerMix } from "../../voice/index.js";

/** A peer without a mix is silent, so nobody is heard before their distance is known. */
const DEFAULT_PEER_MIX: PeerMix = { volume: 0, pan: 0 };

/** The gain one remote player is played at: silent while muted, otherwise the mix volume. */
export function peerGain(mix: PeerMix, muted: boolean): number {
  return muted ? 0 : mix.volume;
}

/** The gains and pans to apply to one peer's playback nodes: through the air, and through a speaker. */
export interface PeerLevels {
  readonly gain: number;
  readonly pan: number;
  readonly radioGain: number;
  readonly radioPan: number;
}

/**
 * Per-peer mix and mute, kept apart so the mix can be rewritten every frame without
 * clobbering a mute. Mutes are remembered by peer id for the whole session: they apply
 * before a peer connects and survive the peer leaving and rejoining.
 */
export function createPeerLevels() {
  const mixes = new Map<string, PeerMix>();
  const muted = new Set<string>();
  return {
    setMix(peerId: string, mix: PeerMix): void {
      mixes.set(peerId, mix);
    },
    setMuted(peerId: string, mute: boolean): void {
      if (mute) muted.add(peerId);
      else muted.delete(peerId);
    },
    /** A peer left: drop its mix, but keep its mute. */
    forget(peerId: string): void {
      mixes.delete(peerId);
    },
    /** The room ended: drop every mix, but keep the mutes. */
    forgetMixes(): void {
      mixes.clear();
    },
    /** Gains and pans to apply to this peer's playback nodes now; a muted peer is silent both ways. */
    levels(peerId: string): PeerLevels {
      const mix = mixes.get(peerId) ?? DEFAULT_PEER_MIX;
      const mute = muted.has(peerId);
      const radio = mix.radio ?? { volume: 0, pan: 0 };
      return {
        gain: peerGain(mix, mute),
        pan: mix.pan,
        radioGain: peerGain(radio, mute),
        radioPan: radio.pan,
      };
    },
    mutedPeers: (): string[] => [...muted],
  };
}
