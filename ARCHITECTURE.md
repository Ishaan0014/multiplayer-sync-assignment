# Architecture

## Overview

```
                       join / cursor / reaction / ping
   ┌──────────┐  ───────────────────────────────────►   ┌──────────┐
   │  Client  │                                          │  Server  │
   │  (React) │  ◄───────────────────────────────────   │   (ws)   │
   └──────────┘   snapshot / peer_joined / peer_left /   └──────────┘
                     cursor / reaction / pong / error

   Client-side, per room:
     connection.ts    — WebSocket lifecycle, throttling, chaos, reconnect
     interpolation.ts — per-peer buffered interpolation
     netstats.ts       — naive-vs-actual bandwidth accounting
     render.ts         — canvas draw of cursors + reaction bursts
     App.tsx            — wires the above + UI controls

   Server-side:
     protocol.ts — message types + runtime validators (shared shape,
                   duplicated by hand in connection.ts)
     room.ts      — Room (per-roomId state, seq gating, O(n) broadcast,
                   heartbeat sweep) + RoomManager (roomId -> Room)
     server.ts    — ws.Server wiring: parses inbound messages, routes to
                   the right Room, drives the heartbeat interval
```

One process, one in-memory `Map<roomId, Room>`. No database, no message queue, no external pub/sub — deliberately, per the brief's "minimal, single-process" server design constraint.

## Alternatives considered

**Interpolation approach.** Considered raw lerp-to-latest (render the most recently received point directly, or lerp toward it each frame). Rejected: under any jitter, drop, or reorder, the rendered cursor either snaps directly to the new point (teleport) or overshoots/undershoots during the lerp, both of which are visually worse than a small fixed delay. Went with buffered interpolation instead — always interpolating between two *real* received points ~120ms behind now, which trades a small constant latency for motion that never snaps, even under packet loss.

**Ordering / staleness scheme.** Considered a global monotonic sequence number for the whole room (single counter, one gate). Rejected: a global counter makes one client's burst of messages able to starve or reorder-invalidate another client's concurrent messages, and requires either locking or a shared atomic counter that doesn't map naturally onto "many independent clients typing at once." Per-client `seq` (each client's own local counter, each remote peer's `lastSeq` tracked independently on the server) needs no coordination between clients and no queue — a stale message from client A can never affect whether client B's message is accepted.

**Transport choice.** Considered a sync/CRDt-style library (Yjs, Liveblocks) or a managed realtime platform (Ably, Pusher, PartyKit). Explicitly banned by the assignment, but also a poor fit for this specific problem even outside that constraint: cursor position is transient, last-write-wins, ephemeral state with no need for merge semantics or conflict resolution — a CRDT's convergence guarantees solve a problem (concurrent structured-document edits) this app doesn't have. Raw WebSocket + a thin hand-rolled protocol is simpler to reason about and cheaper to run for this shape of state.

## Adaptive throttling by measured RTT (bonus — not implemented)

The pieces needed already exist: the client's `{type:"ping"}` / server's `{type:"pong"}` round trip in the protocol gives each client a live RTT sample (`sendTime` on `ping`, measure elapsed on receiving the matching `pong`). The design, if implemented:

1. Client sends `ping` every ~2s (independent of the heartbeat, which is server-initiated and used only for liveness); tracks a rolling average RTT.
2. Client maps RTT to a send interval: low RTT (<50ms) keeps the current 40ms/25Hz rate; degraded RTT (say >200ms) backs off toward a slower rate (e.g. 100ms/10Hz) — sending *more* often on a bad connection just compounds queueing delay and makes the interpolation buffer's job harder, since a slow link is already the bottleneck.
3. This is purely a client-side send-rate decision — the server doesn't need to know or enforce it, since the existing per-client `seq` gate already tolerates any send cadence.

Not implemented here because it's explicitly listed as a bonus item in the brief, after the higher-weighted core protocol/interpolation/server-correctness work (80% of the grade) and the two differentiators that were built (chaos toggle, bandwidth readout).

## Horizontal scaling (bonus — no code, write-up only)

Current design is intentionally single-process: one `RoomManager` holding a `Map<roomId, Room>` in memory, one Node process, one port. This doesn't scale past what a single process can hold in memory and push through one network interface, and a restart drops every room.

Sketch for scaling out:

1. **Shard by `roomId`.** Run N server instances behind a connection-aware load balancer (or a lightweight lookup service) that hashes `roomId` to a specific instance — e.g. `instance = hash(roomId) % N`. Every client for a given room connects to the same instance, so `Room`'s in-process state (positions, `lastSeq` per client, the socket map) needs no changes at all; sharding is purely at the routing layer.
2. **Cross-instance awareness isn't needed for cursor/reaction traffic** as long as sharding is consistent — a room's peers are always co-located on one instance, so the existing O(n) in-process broadcast still applies unchanged.
3. **Redis pub/sub** would only be needed for anything that must fan out *across* instances — e.g. a global presence directory ("which instance is room X on"), or moving to *not* sharding by room (so any instance can serve any client) at the cost of needing pub/sub for every cursor update, which adds a network hop's worth of latency to something that's currently a direct in-process broadcast. Given cursor sync is latency-sensitive, sharding-by-room (no cross-instance chatter on the hot path) is the better fit than a fully mesh-connected pub/sub design.
4. **Rebalancing** (an instance goes down, or the shard count changes) would drop the rooms hosted there; clients would reconnect and get a fresh room via the sharding lookup, rejoining as new peers. Given there's no server-side history/persistence in the current design anyway, this is consistent with the existing "no persistence" limitation rather than a new one.
