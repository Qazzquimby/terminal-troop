import type { PeerMix } from "../../voice/index.js";

/** A peer without a mix is silent, so nobody is heard before their distance is known. */
const DEFAULT_PEER_MIX: PeerMix = { volume: 0, pan: 0 };

/** The gain one remote player is played at: silent while muted, otherwise the mix volume. */
export function peerGain(mix: PeerMix, muted: boolean): number {
  return muted ? 0 : mix.volume;
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
    /** Gain and pan to apply to this peer's playback nodes now. */
    levels(peerId: string): { gain: number; pan: number } {
      const mix = mixes.get(peerId) ?? DEFAULT_PEER_MIX;
      return { gain: peerGain(mix, muted.has(peerId)), pan: mix.pan };
    },
    mutedPeers: (): string[] => [...muted],
  };
}
