import type { Sfx } from "../audio/index.js";
import type { Scope } from "../lib/scope/index.js";
import { NetEvent } from "../net/index.js";
import type { Transport } from "../net/index.js";
import {
  applyRemoteState,
  createSession,
  playerState,
  removePlayer,
} from "../sim/index.js";
import type { Session, SimConfig, WorldKind } from "../sim/index.js";
import type { Voice, VoiceFalloff, VoiceRoom } from "../voice/index.js";
import { parseStateMessage, PresenceMessage } from "./protocol.js";
import { INVALID_ROOM_CODE, parseRoomCode, roomKey } from "./room-code.js";
import { applyProximity, syncVoicePeers } from "./voice-peers.js";

/** How the room shares state with its other players. */
export interface RoomConfig {
  /** Most state sends per second. */
  readonly sendHz: number;
  /** Seconds without a state before a remote player is dropped. */
  readonly staleS: number;
}

/**
 * - lobby: in no room; `error` says why the last attempt to join failed
 * - connecting: joining the room `code`
 * - joined: in the room `code`, playing `session`
 */
export type RoomState =
  | { readonly kind: "lobby"; readonly error: string | null }
  | { readonly kind: "connecting"; readonly code: string }
  | {
      readonly kind: "joined";
      readonly code: string;
      readonly session: Session;
    };

type JoinResult = { ok: true } | { ok: false; error: string };

export interface RoomDeps {
  readonly localId: string;
  readonly world: WorldKind;
  readonly transport: Transport;
  readonly voice: Voice;
  readonly sfx: Sfx;
  /** Each room joined lives in a child of this scope. */
  readonly scope: Scope;
  /** Milliseconds, on the timeline `frame(now)` is called with. */
  readonly clock: { now(): number };
  readonly config: RoomConfig;
  readonly sim: SimConfig;
  readonly falloff: VoiceFalloff;
  /** The state changed, or a remote player arrived or left. */
  onChange(): void;
  /** A voice connection to `id` stayed down past its deadline. */
  onPeerFailed(id: string): void;
}

/** One room's players, messages and voice, from joining it to leaving it. */
export interface Room {
  /** The same object until the state changes. */
  state(): RoomState;
  /**
   * Leaves the current room and joins `rawCode` as `name`. An invalid code changes nothing
   * outside the lobby, and a call while connecting returns at once.
   */
  join(rawCode: string, name: string): Promise<JoinResult>;
  /** Says BYE, hangs up voice and leaves the channel. */
  leave(): Promise<void>;
  /** Runs after the simulation steps of a frame: drops stale players, sends state, mixes voice. */
  frame(now: number): void;
  /** Whether the page is hidden; becoming visible says HELLO again. */
  setHidden(hidden: boolean): void;
  /** When a STATE last came from remote player `id`. */
  lastHeard(id: string): number | undefined;
}

/** A joined room's live parts, shared by its message handlers and the frame. */
interface Link {
  readonly scope: Scope;
  readonly session: Session;
  /** Remote player id to when its last STATE arrived. */
  readonly heard: Map<string, number>;
  voiceRoom: VoiceRoom | null;
  /** The remote players `voiceRoom` was last told to connect to. */
  peers: ReadonlySet<string>;
  lastSent: number;
}

const ALREADY_CONNECTING = "Already connecting.";
const LEFT_WHILE_CONNECTING = "Left before the room was joined.";

export function createRoom(deps: RoomDeps): Room {
  const { localId, transport, clock, config } = deps;
  let state: RoomState = { kind: "lobby", error: null };
  /** The scope of the room joined or being joined. */
  let current: Scope | null = null;
  /** Set exactly while joined. */
  let link: Link | null = null;
  /** Settles once the latest join attempt, its own cleanup included, is over. */
  let attempt: Promise<unknown> = Promise.resolve();
  let hidden = false;

  function setState(next: RoomState): void {
    state = next;
    deps.onChange();
  }

  function sendState(room: Link, now: number, force = false): void {
    if (!force && now - room.lastSent < 1000 / config.sendHz) return;
    room.lastSent = now;
    void transport.send(NetEvent.STATE, playerState(room.session.local));
  }

  function sayHello(room: Link): void {
    void transport.send(NetEvent.HELLO, { id: localId });
    sendState(room, clock.now(), true);
  }

  function syncVoice(room: Link): void {
    if (room.voiceRoom !== null)
      room.peers = syncVoicePeers(
        room.session,
        room.voiceRoom,
        room.peers,
        deps.falloff,
      );
  }

  function dropPlayer(room: Link, id: string): void {
    room.heard.delete(id);
    if (!removePlayer(room.session, id)) return;
    syncVoice(room);
    deps.onChange();
  }

  function handlers(room: Link): Parameters<Transport["join"]>[1] {
    const live =
      (handle: (payload: unknown) => void) =>
      (payload: unknown): void => {
        if (!room.scope.disposed) handle(payload);
      };
    return {
      [NetEvent.STATE]: live((payload) => {
        const message = parseStateMessage(payload, deps.sim.player.nameMax);
        if (message === null) return;
        const result = applyRemoteState(room.session, message);
        if (result === "rejected") return;
        room.heard.set(message.id, clock.now());
        if (result === "added") {
          syncVoice(room);
          deps.onChange();
        }
      }),
      [NetEvent.HELLO]: live(() => {
        sendState(room, clock.now(), true);
      }),
      [NetEvent.BYE]: live((payload) => {
        const message = PresenceMessage.safeParse(payload);
        if (message.success) dropPlayer(room, message.data.id);
      }),
      [NetEvent.SIGNAL]: live((payload) => {
        room.voiceRoom?.receive(payload);
      }),
    };
  }

  /**
   * Joins `code` inside `scope`. The scope's disposers run in reverse: BYE, then voice hangs
   * up, then the channel closes, then sound loops stop. Null when the scope is disposed first.
   */
  async function connect(
    code: string,
    name: string,
    scope: Scope,
  ): Promise<Link | null> {
    scope.defer(() => {
      deps.sfx.stopAll();
    });
    const room: Link = {
      scope,
      session: createSession(
        localId,
        name,
        code,
        deps.world,
        deps.sfx,
        deps.sim,
      ),
      heard: new Map(),
      voiceRoom: null,
      peers: new Set(),
      lastSent: -Infinity,
    };
    await transport.join(roomKey(code, deps.world), handlers(room));
    if (scope.disposed) {
      await transport.leave();
      return null;
    }
    scope.defer(() => transport.leave());
    room.voiceRoom = scope.adopt(
      deps.voice.join(
        localId,
        (signal) => void transport.send(NetEvent.SIGNAL, signal),
        {
          peerFailed(id) {
            deps.onPeerFailed(id);
          },
        },
      ),
      (voiceRoom) => {
        voiceRoom.leave();
      },
    );
    scope.defer(() => transport.send(NetEvent.BYE, { id: localId }));
    syncVoice(room);
    sayHello(room);
    return room;
  }

  async function attemptJoin(
    code: string,
    name: string,
    scope: Scope,
    previous: Scope | null,
    before: Promise<unknown>,
  ): Promise<JoinResult> {
    try {
      await before;
      await previous?.dispose();
      const joined = scope.disposed ? null : await connect(code, name, scope);
      if (joined === null) return { ok: false, error: LEFT_WHILE_CONNECTING };
      link = joined;
      setState({ kind: "joined", code, session: joined.session });
      return { ok: true };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to join room.";
      if (current === scope) {
        current = null;
        setState({ kind: "lobby", error: message });
      }
      await scope.dispose();
      return { ok: false, error: message };
    }
  }

  return {
    state: () => state,

    join(rawCode, name) {
      if (state.kind === "connecting")
        return Promise.resolve({ ok: false, error: ALREADY_CONNECTING });
      const code = parseRoomCode(rawCode);
      if (code === null) {
        if (state.kind === "lobby")
          setState({ kind: "lobby", error: INVALID_ROOM_CODE });
        return Promise.resolve({ ok: false, error: INVALID_ROOM_CODE });
      }

      const previous = current;
      const scope = deps.scope.child();
      current = scope;
      link = null;
      setState({ kind: "connecting", code });
      const result = attemptJoin(code, name, scope, previous, attempt);
      attempt = result.catch(() => undefined);
      return result;
    },

    async leave() {
      const scope = current;
      current = null;
      link = null;
      if (state.kind !== "lobby") setState({ kind: "lobby", error: null });
      await scope?.dispose();
    },

    frame(now) {
      if (link === null) return;
      const room = link;
      for (const [id, heard] of room.heard) {
        if (now - heard > config.staleS * 1000) dropPlayer(room, id);
      }
      sendState(room, now);
      syncVoice(room);
      if (room.voiceRoom !== null)
        applyProximity(room.session, room.voiceRoom, deps.falloff);
    },

    setHidden(next) {
      const shown = hidden && !next;
      hidden = next;
      if (shown && link !== null) sayHello(link);
    },

    lastHeard: (id) => link?.heard.get(id),
  };
}
