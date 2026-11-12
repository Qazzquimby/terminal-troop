import type { Sfx } from "../audio/index.js";
import type { Scope } from "../lib/scope/index.js";
import { NetEvent, createBatchingTransport } from "../net/index.js";
import type { Transport } from "../net/index.js";
import {
  applyEntityChanges,
  applyEntitySnapshot,
  applyRemoteState,
  applyWorldState,
  cueEntities,
  createSession,
  entitySnapshot,
  playerState,
  receiveEvent,
  registerContent,
  removePlayer,
  worldState,
} from "../sim/index.js";
import type {
  OutgoingEvent,
  Session,
  SimConfig,
  WorldContent,
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
import type { Message, WireMessage } from "./protocol.js";
import { INVALID_ROOM_CODE, parseRoomCode, roomKey } from "./room-code.js";
import { applyProximity, syncVoicePeers } from "./voice-peers.js";

/** How the room shares state with its other players. */
export interface RoomConfig {
  /**
   * Network ticks per second. A tick sends, as one broadcast, the local player's state if it
   * changed since it was last sent, and the entities while hosting.
   */
  readonly sendHz: number;
  /**
   * Milliseconds between full entity snapshots, while hosting. Between them a snapshot carries
   * only the entities that changed and the ids of those gone; a full one, also sent to each
   * newcomer and as a new host's first, mends what a lost snapshot missed.
   */
  readonly fullSnapshotMs: number;
  /**
   * Milliseconds between heartbeats, and between presence sweeps. A shown page's heartbeat
   * carries its player's state whether or not that changed, and goes out with the next tick.
   */
  readonly heartbeatMs: number;
  readonly presence: PresenceTiming;
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
  /** What the world holds. Every client registers it in this order, which numbers its kinds. */
  readonly content: readonly WorldContent[];
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
   * Runs after the simulation steps of a frame: on a tick sends what the tick carries, sends the
   * state at once when it must go out now, and routes the content events sent in those steps,
   * all in one broadcast; then plays the entities' sound cues and mixes voice.
   */
  frame(now: number): void;
  /** Whether the page is hidden; says so in a heartbeat at once. */
  setHidden(hidden: boolean): void;
  /** Undefined for a remote player who is gone, or outside a room. */
  presenceOf(id: string): Presence | undefined;
  /**
   * The one player who runs the shared world: it runs the entities and sends them to everyone
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
  /** When the next tick is due. */
  nextTick: number;
  /** The local player's state as last sent, as JSON; null before the first. */
  lastState: string | null;
  /** The next frame sends state whether or not it ticks, or the state changed. */
  forceState: boolean;
  /** A frame ran since the last pulse. */
  framed: boolean;
  /** The next tick carries a heartbeat. */
  beatDue: boolean;
  /** Undefined until the first view is heard or the first heartbeat elects one. */
  host: HostView | undefined;
  /** The host view each remote player last sent; null before it sent one. */
  readonly views: Map<string, HostView | null>;
  /** When the last heartbeat was due to go out. */
  lastPulse: number;
  /** When the last full entity snapshot went out. */
  lastFullSent: number;
  /** Each entity as this client last sent it while hosting, by id; empty while not hosting. */
  sent: Map<string, string>;
  /** The world has its starting entities: this client spawned them or heard them from a host. */
  populated: boolean;
}

const ALREADY_CONNECTING = "Already connecting.";
const LEFT_WHILE_CONNECTING = "Left before the room was joined.";

export function createRoom(deps: RoomDeps): Room {
  const { localId, clock, config } = deps;
  const { transport, batch } = createBatchingTransport(deps.transport);
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
    [E in NetEvent]: z.ZodType<Message<E>, WireMessage<E>>;
  } = roomMessages(deps.sim.player.nameMax);

  /** Encodes `msg` for the wire and sends it as `event` to the rest of the room. */
  function send<E extends NetEvent>(event: E, msg: Message<E>): Promise<void> {
    return transport.send(event, messages[event].encode(msg));
  }

  function setState(next: RoomState): void {
    state = next;
    deps.onChange();
  }

  /** Sends the local player's state when forced, or on a tick when it changed since last sent. */
  function sendState(room: Link, force: boolean, ticking = false): void {
    if (!force && !ticking) return;
    const wire = messages[NetEvent.STATE].encode(playerState(room.session));
    const json = JSON.stringify(wire);
    if (!force && json === room.lastState) return;
    room.lastState = json;
    room.forceState = false;
    room.session.reportNow = false;
    void transport.send(NetEvent.STATE, wire);
  }

  /**
   * Hands `outgoing` to each client its route reaches: this one's next step without a round
   * trip, the others over the transport. One for the host is dropped while no host is known.
   */
  function route(room: Link, outgoing: OutgoingEvent): void {
    const host = room.host?.id;
    const { route: reach, ...address } = outgoing;
    const message = { ...address, from: localId };
    const here =
      reach === "all" ||
      (reach === "host" ? host === localId : outgoing.to === localId);
    const away =
      reach === "all" ||
      (reach === "host"
        ? host !== undefined && host !== localId
        : outgoing.to !== localId);
    if (here) receiveEvent(room.session, message, host);
    if (away) void send(NetEvent.CONTENT, message);
  }

  /**
   * Sends the entities and the world state: in full when forced, as this client's first while
   * hosting, or every `fullSnapshotMs`; otherwise only the entities changed since the last
   * send, and the ids of those gone.
   */
  function sendEntities(room: Link, now: number, force = false): void {
    const entities = entitySnapshot(room.session);
    const current = new Map(
      entities.map((entity) => [entity.id, JSON.stringify(entity)]),
    );
    const full =
      force ||
      room.sent.size === 0 ||
      now - room.lastFullSent >= config.fullSnapshotMs;
    const previous = room.sent;
    room.sent = current;
    if (full) room.lastFullSent = now;
    void send(NetEvent.ENTITIES, {
      host: localId,
      full,
      entities: full
        ? entities
        : entities.filter(
            (entity) => previous.get(entity.id) !== current.get(entity.id),
          ),
      removed: full
        ? []
        : [...previous.keys()].filter((id) => !current.has(id)),
      world: worldState(room.session),
    });
  }

  /**
   * Holds `view` as the host view. Only the host runs the entities, and a host whose world has
   * no starting entities yet spawns them.
   */
  function holdView(room: Link, view: HostView | undefined): void {
    room.host = view;
    const hosting = view?.id === localId;
    room.session.hosting = hosting;
    if (!hosting) room.sent.clear();
    if (hosting && !room.populated) {
      for (const content of deps.content) content.populate(room.session);
      room.populated = true;
    }
  }

  /**
   * Sends what a tick carries, and schedules the next: a heartbeat when one is due, the local
   * player's state if it changed since last sent, must go out now, or goes with a heartbeat, and
   * the entities while hosting.
   */
  function tick(room: Link, now: number): void {
    const interval = 1000 / config.sendHz;
    // Ticks keep to their schedule, so frames that fall just short of one do not slow them.
    room.nextTick = Math.max(room.nextTick, now - interval / 2) + interval;
    if (room.beatDue) beatNow(room);
    else sendState(room, room.forceState || room.session.reportNow, true);
    if (room.host?.id === localId) sendEntities(room, now);
  }

  /** A heartbeat, with the local player's state while the page is shown. */
  function beatNow(room: Link): void {
    room.beatDue = false;
    batch(() => {
      sendHeartbeat(room);
      if (!hidden) sendState(room, true);
    });
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
        if (parsed.success)
          batch(() => {
            handle(parsed.data);
          });
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
        if (message.full) applyEntitySnapshot(room.session, message.entities);
        else
          applyEntityChanges(room.session, message.entities, message.removed);
        applyWorldState(room.session, message.world);
        room.populated = true;
      }),
      [NetEvent.CONTENT]: on(NetEvent.CONTENT, (message) => {
        if (message.from === localId) return;
        if (room.roster.get(message.from) === undefined) return;
        receiveEvent(room.session, message, room.host?.id);
      }),
      [NetEvent.HELLO]: on(NetEvent.HELLO, (message) => {
        hear(room, message.id, { kind: "hello" });
        sendState(room, true);
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
   * qualifies, then says the local player is still here: with the next tick while frames run,
   * otherwise at once.
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
    if (hidden || !room.framed) beatNow(room);
    else room.beatDue = true;
    room.framed = false;
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
    registerContent(session, deps.content);
    session.hosting = false;
    const room: Link = {
      scope,
      session,
      roster: createRoster(config.presence),
      voiceRoom: null,
      peers: new Set(),
      nextTick: clock.now() + 1000 / config.sendHz,
      lastState: null,
      forceState: false,
      framed: false,
      beatDue: false,
      host: undefined,
      views: new Map(),
      lastPulse: clock.now(),
      lastFullSent: -Infinity,
      sent: new Map(),
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
    batch(() => {
      void send(NetEvent.HELLO, { id: localId });
      sendState(room, true);
    });
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
      room.framed = true;
      batch(() => {
        if (now >= room.nextTick) tick(room, now);
        else sendState(room, room.forceState || room.session.reportNow);
        for (const outgoing of room.session.outbox.splice(0))
          route(room, outgoing);
      });
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
