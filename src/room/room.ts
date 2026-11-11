import type { Sfx } from "../audio/index.js";
import type { Scope } from "../lib/scope/index.js";
import { NetEvent } from "../net/index.js";
import type { Transport } from "../net/index.js";
import {
  applyEntitySnapshot,
  applyRemoteState,
  cueEntities,
  createSession,
  entitySnapshot,
  applyDamage,
  playerState,
  removePlayer,
  requestUse,
  showUse,
} from "../sim/index.js";
import type {
  Session,
  SimConfig,
  UseRequest,
  WorldKind,
} from "../sim/index.js";
import type { Voice, VoiceFalloff, VoiceRoom } from "../voice/index.js";
import type { z } from "zod";
import { adopt, elect } from "./host.js";
import type { HostView, RemoteCandidate } from "./host.js";
import { createRoster } from "./presence.js";
import type {
  Presence,
  PresenceChange,
  PresenceEvent,
  PresenceTiming,
  Roster,
} from "./presence.js";
import { roomMessages } from "./protocol.js";
import type { Message, MessageInput } from "./protocol.js";
import { INVALID_ROOM_CODE, parseRoomCode, roomKey } from "./room-code.js";
import { applyProximity, syncVoicePeers } from "./voice-peers.js";

/** How the room shares state with its other players. */
export interface RoomConfig {
  /** Most state sends per second. */
  readonly sendHz: number;
  /** Most entity snapshots per second, while hosting. */
  readonly entityHz: number;
  /** Milliseconds between heartbeats, and between presence sweeps. */
  readonly heartbeatMs: number;
  readonly presence: PresenceTiming;
}

/** The monsters a room's world holds. */
export interface Monsters {
  /** Registers their kinds with a new session, before any snapshot reaches it. */
  register(session: Session): void;
  /** Spawns the ones a new world starts with. */
  populate(session: Session): void;
}

/** The usable items a room's players hold. */
export interface Items {
  /** Registers what each one does with a new session, and stocks its local player's inventory. */
  register(session: Session): void;
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

/** Milliseconds, on the timeline `frame(now)` is called with. */
interface RoomClock {
  now(): number;
  /** Calls `fn` every `ms` until the returned function is called. */
  every(ms: number, fn: () => void): () => void;
}

export interface RoomDeps {
  readonly localId: string;
  readonly world: WorldKind;
  readonly transport: Transport;
  readonly voice: Voice;
  readonly sfx: Sfx;
  /** Each room joined lives in a child of this scope. */
  readonly scope: Scope;
  readonly clock: RoomClock;
  readonly config: RoomConfig;
  readonly sim: SimConfig;
  readonly monsters: Monsters;
  readonly items: Items;
  readonly falloff: VoiceFalloff;
  /** The state changed, or a remote player arrived, left, or changed presence. */
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
  /**
   * Runs after the simulation steps of a frame: sends state, sends the local player's item uses,
   * sends the damage dealt, plays the entities' sound cues, then mixes voice.
   */
  frame(now: number): void;
  /** Whether the page is hidden; says so in a heartbeat at once. */
  setHidden(hidden: boolean): void;
  /** Undefined for a remote player who is gone, or outside a room. */
  presenceOf(id: string): Presence | undefined;
  /**
   * The one player who runs the shared world: it runs the monsters and sends them to everyone
   * else. A host keeps the role while it is active; only when it goes away, leaves or hides
   * does a new one take over, and every client adopts the latest election it hears. Undefined
   * outside a room, and on joining until the host is heard or the first heartbeat elects one.
   */
  hostId(): string | undefined;
}

/** A joined room's live parts, shared by its message handlers, its pulse and the frame. */
interface Link {
  readonly scope: Scope;
  readonly session: Session;
  readonly roster: Roster;
  voiceRoom: VoiceRoom | null;
  /** The remote players `voiceRoom` was last told to connect to. */
  peers: ReadonlySet<string>;
  lastSent: number;
  /** The next frame sends state whatever the throttle says. */
  forceState: boolean;
  /** Undefined until the first view is heard or the first heartbeat elects one. */
  host: HostView | undefined;
  /** The host view each remote player last sent; null before it sent one. */
  readonly views: Map<string, HostView | null>;
  /** When the last heartbeat was due to go out. */
  lastPulse: number;
  lastEntitiesSent: number;
  /** The world has its monsters: this client spawned them or heard them from a host. */
  populated: boolean;
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
  /** Mapped over each event, so indexing it with a generic event keeps that event's types. */
  const messages: {
    [E in NetEvent]: z.ZodType<Message<E>, MessageInput<E>>;
  } = roomMessages(deps.sim.player.nameMax);

  /** Sends `msg` as `event` to the rest of the room. */
  function send<E extends NetEvent>(
    event: E,
    msg: MessageInput<E>,
  ): Promise<void> {
    return transport.send(event, msg);
  }

  function setState(next: RoomState): void {
    state = next;
    deps.onChange();
  }

  function sendState(room: Link, now: number, force = false): void {
    if (!force && now - room.lastSent < 1000 / config.sendHz) return;
    room.lastSent = now;
    room.forceState = false;
    void send(NetEvent.STATE, playerState(room.session.local));
  }

  /**
   * Sends an item use to the room, for the host to apply and everyone else to hear, and
   * queues it for this client's next step while hosting. Dropped while no host is known.
   */
  function handUse(room: Link, request: UseRequest): void {
    const host = room.host?.id;
    if (host === undefined) return;
    if (host === localId) requestUse(room.session, request);
    void send(NetEvent.USE, request);
  }

  /** Sends each remote player the damage dealt to it since the last frame. */
  function sendStrikes(room: Link): void {
    for (const { target, amount } of room.session.strikes.splice(0))
      void send(NetEvent.DAMAGE, { host: localId, target, amount });
  }

  function sendEntities(room: Link, now: number, force = false): void {
    if (!force && now - room.lastEntitiesSent < 1000 / config.entityHz) return;
    room.lastEntitiesSent = now;
    void send(NetEvent.ENTITIES, {
      host: localId,
      entities: entitySnapshot(room.session),
    });
  }

  /**
   * Holds `view` as the host view. Only the host runs the entities, and a host whose world has
   * no monsters yet spawns them.
   */
  function holdView(room: Link, view: HostView | undefined): void {
    room.host = view;
    const hosting = view?.id === localId;
    room.session.hosting = hosting;
    if (hosting && !room.populated) {
      deps.monsters.populate(room.session);
      room.populated = true;
    }
  }

  function sendHeartbeat(room: Link): void {
    void send(NetEvent.HEARTBEAT, {
      id: localId,
      hidden,
      host: room.host ?? null,
    });
  }

  /** Every remote player present or away, with the view it last sent. */
  function remotes(room: Link): RemoteCandidate[] {
    const { roster, views } = room;
    return [...roster.ids()].map((id) => ({
      id,
      active: roster.get(id)?.kind === "present",
      view: views.get(id) ?? null,
    }));
  }

  function syncVoice(room: Link): void {
    if (room.voiceRoom !== null)
      room.peers = syncVoicePeers(
        room.session,
        room.roster.ids(),
        room.voiceRoom,
        room.peers,
        deps.falloff,
      );
  }

  /** Drops the players `changes` made gone, then points voice at who is left. */
  function settle(room: Link, changes: readonly PresenceChange[]): void {
    for (const change of changes) {
      if (change.to !== "gone") continue;
      removePlayer(room.session, change.id);
      room.views.delete(change.id);
    }
    syncVoice(room);
    if (changes.length > 0) deps.onChange();
  }

  function hear(room: Link, id: string, event: PresenceEvent): void {
    const change = room.roster.apply(id, event, clock.now());
    if (change !== null) settle(room, [change]);
  }

  function handlers(room: Link): Parameters<Transport["join"]>[1] {
    /** The transport's handler for `event`: drops payloads that arrive after leaving or do not parse. */
    function on<E extends NetEvent>(
      event: E,
      handle: (msg: Message<E>) => void,
    ): (payload: unknown) => void {
      return (payload) => {
        if (room.scope.disposed) return;
        const parsed = messages[event].safeParse(payload);
        if (parsed.success) handle(parsed.data);
      };
    }
    return {
      [NetEvent.STATE]: on(NetEvent.STATE, (message) => {
        const change = room.roster.apply(
          message.id,
          { kind: "heard", hidden: false },
          clock.now(),
        );
        if (room.roster.get(message.id) === undefined) return;
        const added = applyRemoteState(room.session, message) === "added";
        if (change !== null) settle(room, [change]);
        else if (added) {
          syncVoice(room);
          deps.onChange();
        }
      }),
      [NetEvent.HEARTBEAT]: on(NetEvent.HEARTBEAT, (message) => {
        hear(room, message.id, { kind: "heard", hidden: message.hidden });
        if (room.roster.get(message.id) === undefined) return;
        room.views.set(message.id, message.host);
        holdView(room, adopt(room.host, message.host));
      }),
      [NetEvent.ENTITIES]: on(NetEvent.ENTITIES, (message) => {
        if (message.host === localId || message.host !== room.host?.id) return;
        applyEntitySnapshot(room.session, message.entities);
        room.populated = true;
      }),
      [NetEvent.USE]: on(NetEvent.USE, (message) => {
        if (message.by === localId) return;
        if (room.roster.get(message.by) === undefined) return;
        showUse(room.session, message);
        if (room.host?.id === localId) requestUse(room.session, message);
      }),
      [NetEvent.DAMAGE]: on(NetEvent.DAMAGE, (message) => {
        if (message.target !== localId) return;
        if (message.host === localId || message.host !== room.host?.id) return;
        applyDamage(room.session.local, message.amount);
        room.forceState = true;
      }),
      [NetEvent.HELLO]: on(NetEvent.HELLO, (message) => {
        hear(room, message.id, { kind: "hello" });
        sendState(room, clock.now(), true);
        // The newcomer learns the host view at once, and a hidden page undoes the visible STATE.
        sendHeartbeat(room);
        if (room.host?.id === localId) sendEntities(room, clock.now(), true);
      }),
      [NetEvent.BYE]: on(NetEvent.BYE, ({ id }) => {
        const change = room.roster.apply(id, { kind: "bye" }, clock.now());
        const removed = removePlayer(room.session, id);
        room.views.delete(id);
        syncVoice(room);
        if (change !== null || removed) deps.onChange();
      }),
      [NetEvent.SIGNAL]: on(NetEvent.SIGNAL, (signal) => {
        room.voiceRoom?.receive(signal);
      }),
    };
  }

  /**
   * Moves every remote player along by the time, elects a host if the one held no longer
   * qualifies, then says the local player is still here.
   */
  function pulse(room: Link): void {
    if (room.scope.disposed) return;
    const now = clock.now();
    // A page whose timers stalled finds everyone silent, so it waits for their news to elect.
    const stalled = now - room.lastPulse > config.presence.awayAfterMs;
    room.lastPulse = now;
    const changes = room.roster.sweep(now);
    if (room.voiceRoom !== null)
      applyProximity(room.session, room.peers, room.voiceRoom, deps.falloff);
    settle(room, changes);
    if (!stalled || room.host === undefined)
      holdView(
        room,
        elect(room.host, { id: localId, active: !hidden }, remotes(room)),
      );
    sendHeartbeat(room);
  }

  /**
   * Joins `code` inside `scope`. The scope's disposers run in reverse: BYE, then heartbeats
   * stop, then voice hangs up, then the channel closes, then sound loops stop. Null when the
   * scope is disposed first.
   */
  async function connect(
    code: string,
    name: string,
    scope: Scope,
  ): Promise<Link | null> {
    scope.defer(() => {
      deps.sfx.stopAll();
    });
    const session = createSession(
      localId,
      name,
      code,
      deps.world,
      deps.sfx,
      deps.sim,
    );
    deps.monsters.register(session);
    deps.items.register(session);
    session.hosting = false;
    const room: Link = {
      scope,
      session,
      roster: createRoster(config.presence),
      voiceRoom: null,
      peers: new Set(),
      lastSent: -Infinity,
      forceState: false,
      host: undefined,
      views: new Map(),
      lastPulse: clock.now(),
      lastEntitiesSent: -Infinity,
      populated: false,
    };
    await transport.join(roomKey(code, deps.world), handlers(room));
    if (scope.disposed) {
      await transport.leave();
      return null;
    }
    scope.defer(() => transport.leave());
    room.voiceRoom = scope.adopt(
      deps.voice.join(localId, (signal) => void send(NetEvent.SIGNAL, signal), {
        peerFailed(id) {
          if (!scope.disposed) hear(room, id, { kind: "voiceFailed" });
          deps.onPeerFailed(id);
        },
      }),
      (voiceRoom) => {
        voiceRoom.leave();
      },
    );
    scope.adopt(
      clock.every(config.heartbeatMs, () => {
        pulse(room);
      }),
      (stop) => {
        stop();
      },
    );
    scope.defer(() => send(NetEvent.BYE, { id: localId }));
    void send(NetEvent.HELLO, { id: localId });
    sendState(room, clock.now(), true);
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
      sendState(room, now, room.forceState);
      for (const request of room.session.localUses.splice(0))
        handUse(room, request);
      sendStrikes(room);
      if (room.host?.id === localId) sendEntities(room, now);
      cueEntities(room.session);
      if (room.voiceRoom !== null)
        applyProximity(room.session, room.peers, room.voiceRoom, deps.falloff);
    },

    setHidden(next) {
      const shown = hidden && !next;
      hidden = next;
      if (link === null) return;
      sendHeartbeat(link);
      if (shown) link.forceState = true;
    },

    presenceOf: (id) => link?.roster.get(id),

    hostId: () => link?.host?.id,
  };
}
