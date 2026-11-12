import type { Sfx } from "../audio/index.js";
import type { Scope } from "../lib/scope/index.js";
import { NetEvent, createBatchingTransport } from "../net/index.js";
import type { Transport } from "../net/index.js";
import {
  applyEntityChanges,
  applyEntitySnapshot,
  applyRemoteState,
  applyWorldEntries,
  cueEntities,
  createSession,
  entityDelta,
  entitySnapshot,
  playerState,
  receiveEvent,
  registerContent,
  removePlayer,
  roomSeed,
  takeWorldEntries,
} from "../sim/index.js";
import type {
  EntitySnapshot,
  OutgoingEvent,
  Point,
  Session,
  SimConfig,
  WorldContent,
  WorldKind,
} from "../sim/index.js";
import type { Voice, VoiceFalloff, VoiceRoom } from "../voice/index.js";
import type { z } from "zod";
import { adopt, elect, sameElection } from "./host.js";
import type { HostView, RemoteCandidate } from "./host.js";
import { createRoster } from "./presence.js";
import type {
  Presence,
  PresenceChange,
  PresenceEvent,
  PresenceTiming,
  Roster,
} from "./presence.js";
import { asSent, roomMessages } from "./protocol.js";
import type { Message, WireMessage } from "./protocol.js";
import { INVALID_ROOM_CODE, parseRoomCode, roomKey } from "./room-code.js";
import { applyProximity, syncVoicePeers } from "./voice-peers.js";

/** How the room shares state with its other players. */
export interface RoomConfig {
  /**
   * Network ticks per second. A tick sends, as one broadcast, the local player's state if it
   * changed since it was last sent, and while hosting the world state that changed and the
   * entities.
   */
  readonly sendHz: number;
  /**
   * Milliseconds between full entity snapshots, and between full sends of the world state, while
   * hosting. Between them a snapshot carries only the entities that changed and the ids of those
   * gone, and the world state only the entries that changed; a full one, also sent to each
   * newcomer and as a new host's first, mends what a lost one missed.
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
  /** The local player's id on joining; `renewId` replaces it. */
  readonly localId: string;
  /**
   * A fresh id for the local player, kept for its later joins too. Called when another client
   * already plays under the local player's id, as when a tab is duplicated with its storage.
   * Without it, the clash goes unresolved.
   */
  renewId?(): string;
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
  /**
   * Where the local player stood when last in the world the room `room` builds from `seed`, if
   * anywhere; it starts there if it can stand there, and by the rally point otherwise.
   */
  savedPosition?(place: {
    readonly player: string;
    readonly room: string;
    readonly world: WorldKind;
    readonly seed: number;
  }): Point | undefined;
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
  readonly code: string;
  readonly name: string;
  readonly scope: Scope;
  /** When this client said HELLO. */
  joinedAt: number;
  /** Another client plays under the local id, and this one is to take a fresh id. */
  clashed: boolean;
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
  /** When the world state last went out in full. */
  lastWorldFull: number;
  /** The next tick sends the world state in full. */
  worldFullDue: boolean;
  /** Each entity as this client last sent it while hosting, by id; empty while not hosting. */
  sent: Map<string, EntitySnapshot>;
  /**
   * Who spawned the starting entities of the world this client holds: this client, or the one its
   * hosts' snapshots name. Null before it has any.
   */
  origin: string | null;
}

const ALREADY_CONNECTING = "Already connecting.";
const LEFT_WHILE_CONNECTING = "Left before the room was joined.";

export function createRoom(deps: RoomDeps): Room {
  const { clock, config } = deps;
  const { transport, batch } = createBatchingTransport(deps.transport);
  let localId = deps.localId;
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
   * Sends the entities: in full when forced, as this client's first while hosting, or every
   * `fullSnapshotMs`; otherwise only what changed since the last send, as the others hold it.
   */
  function sendEntities(room: Link, now: number, force = false): void {
    const entities = entitySnapshot(room.session).map(asSent);
    const full =
      force ||
      room.sent.size === 0 ||
      now - room.lastFullSent >= config.fullSnapshotMs;
    const { added, changed, removed } = full
      ? { added: entities, changed: [], removed: [] }
      : entityDelta(room.sent, entities);
    room.sent = new Map(entities.map((entity) => [entity.id, entity]));
    if (full) room.lastFullSent = now;
    void send(NetEvent.ENTITIES, {
      host: localId,
      origin: room.origin ?? localId,
      full,
      time: room.session.worldTime,
      entities: added,
      changed,
      removed,
    });
  }

  /**
   * Sends the world state: in full when forced, due, or every `fullSnapshotMs`; otherwise the
   * entries set since the last send, if any.
   */
  function sendWorld(room: Link, now: number, force = false): void {
    const term = room.host?.term;
    if (term === undefined) return;
    const full =
      force ||
      room.worldFullDue ||
      now - room.lastWorldFull >= config.fullSnapshotMs;
    const entries = takeWorldEntries(room.session, full);
    if (full) {
      room.lastWorldFull = now;
      room.worldFullDue = false;
    }
    if (entries !== null)
      void send(NetEvent.WORLD, { host: localId, term, entries });
  }

  /**
   * Holds `view` as the host view. Only the host runs the entities, and a host whose world has
   * no starting entities yet spawns them. A client that takes over sends its world state in full
   * with its next tick.
   */
  function holdView(room: Link, view: HostView | undefined): void {
    if (
      view === undefined ||
      room.host === undefined ||
      !sameElection(view, room.host)
    )
      room.worldFullDue = true;
    room.host = view;
    const hosting = view?.id === localId;
    room.session.hosting = hosting;
    if (!hosting) room.sent.clear();
    if (hosting && room.origin === null) {
      for (const content of deps.content) content.populate(room.session);
      room.origin = localId;
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
    if (room.host?.id === localId) {
      sendWorld(room, now);
      sendEntities(room, now);
    }
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
        if (message.id === localId) {
          heardOwnId(room);
          return;
        }
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
        if (message.id === localId) {
          heardOwnId(room);
          return;
        }
        hear(room, message.id, { kind: "heard", hidden: message.hidden });
        if (room.roster.get(message.id) === undefined) return;
        const before = room.views.get(message.id) ?? null;
        room.views.set(message.id, message.host);
        holdView(room, adopt(room.host, message.host));
        // A player that has just come to follow this host, as after a split heals, needs its world.
        const { host } = room;
        if (
          host?.id === localId &&
          sameElection(host, message.host) &&
          !sameElection(host, before)
        )
          room.worldFullDue = true;
      }),
      [NetEvent.ENTITIES]: on(NetEvent.ENTITIES, (message) => {
        if (message.host === localId || message.host !== room.host?.id) return;
        // Entity ids are counted per world, so another world's entities share none with this one.
        if (message.origin !== room.origin) room.session.entities.clear();
        room.origin = message.origin;
        room.session.worldTime = message.time;
        if (message.full) applyEntitySnapshot(room.session, message.entities);
        else
          applyEntityChanges(room.session, {
            added: message.entities,
            changed: message.changed,
            removed: message.removed,
          });
      }),
      [NetEvent.WORLD]: on(NetEvent.WORLD, (message) => {
        const { host } = room;
        if (
          host === undefined ||
          host.id === localId ||
          message.host !== host.id ||
          message.term !== host.term
        )
          return;
        applyWorldEntries(room.session, message, message.entries);
      }),
      [NetEvent.CONTENT]: on(NetEvent.CONTENT, (message) => {
        if (message.from === localId) return;
        if (room.roster.get(message.from) === undefined) return;
        receiveEvent(room.session, message, room.host?.id);
      }),
      [NetEvent.HELLO]: on(NetEvent.HELLO, (message) => {
        if (message.id === localId) heardOwnId(room);
        else {
          hear(room, message.id, { kind: "hello" });
          // A host that says HELLO again has lost the world it ran, so the others take it over.
          if (room.host?.id === message.id) handOver(room, message.id);
        }
        if (room.clashed) return;
        sendState(room, true);
        // The newcomer learns the host view at once, and a hidden page undoes the visible STATE.
        sendHeartbeat(room);
        if (room.host?.id === localId) {
          sendWorld(room, clock.now(), true);
          sendEntities(room, clock.now(), true);
        }
      }),
      [NetEvent.BYE]: on(NetEvent.BYE, ({ id }) => {
        if (id === localId) return;
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
   * Runs a new election among everyone but `id`, the host, which joined again without the
   * world it ran.
   */
  function handOver(room: Link, id: string): void {
    holdView(
      room,
      elect(
        room.host,
        { id: localId, active: !hidden },
        remotes(room).filter((remote) => remote.id !== id),
      ),
    );
  }

  /**
   * Another client plays under the local id. A client that hears its own id from another within
   * `awayAfterMs` of its HELLO takes a fresh id and joins again; one that has been in the room
   * longer keeps it. So a page that joins after a copy of itself has settled in renews, and of
   * two that join at once, at least the first to hear the other does.
   */
  function heardOwnId(room: Link): void {
    if (room.clashed || deps.renewId === undefined) return;
    if (clock.now() - room.joinedAt >= config.presence.awayAfterMs) return;
    room.clashed = true;
    if (link === room) rejoin(room);
  }

  /** Takes a fresh id and joins `room`'s code again under it. */
  function rejoin(room: Link): void {
    if (deps.renewId === undefined) return;
    localId = deps.renewId();
    void joinRoom(room.code, room.name);
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
    const seed = roomSeed(code, deps.sim.world.seed);
    const session = createSession(
      localId,
      name,
      code,
      deps.world,
      deps.sfx,
      deps.sim,
      {
        at: deps.savedPosition?.({
          player: localId,
          room: code,
          world: deps.world,
          seed,
        }),
      },
    );
    registerContent(session, deps.content);
    session.hosting = false;
    const room: Link = {
      code,
      name,
      scope,
      joinedAt: clock.now(),
      clashed: false,
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
      lastWorldFull: -Infinity,
      worldFullDue: false,
      sent: new Map(),
      origin: null,
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
    const id = localId;
    // A client leaving over a clash says no BYE: the id stays with the client that keeps it.
    scope.defer(() =>
      room.clashed ? Promise.resolve() : send(NetEvent.BYE, { id }),
    );
    room.joinedAt = clock.now();
    batch(() => {
      void send(NetEvent.HELLO, { id });
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
      if (joined.clashed) rejoin(joined);
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

  function joinRoom(rawCode: string, name: string): Promise<JoinResult> {
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
  }

  return {
    state: () => state,

    join: joinRoom,

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
