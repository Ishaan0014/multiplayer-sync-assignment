# Real-Time Multiplayer Cursor Sync

Raw WebSocket cursor/state sync — no Socket.IO/Yjs/Liveblocks/PartyKit/Ably/Pusher, just `ws` on the server and native `WebSocket` on the client.

## Setup

```bash
# terminal 1 — server
cd server
npm install
npm run dev          # ws://localhost:8080

# terminal 2 — client
cd client
npm install
npm run dev           # http://localhost:5173
```

Open `http://localhost:5173` in two or more browser tabs/windows to see multiple cursors sync. All tabs join the same room (`?room=default`) unless you pass `?room=<name>` in the URL — open `http://localhost:5173/?room=test` in each tab to isolate a session from other testers.

Move your mouse over the canvas to broadcast your cursor. Click anywhere for a random emoji reaction, or pick a specific one from the reaction dock at the bottom of the screen. The floating panel (top-right, toggled via the gear icon) exposes the network chaos controls, the interpolation render-delay slider, and the live naive-vs-actual bandwidth comparison described below.

## Protocol

Defined once in [`server/src/protocol.ts`](server/src/protocol.ts) and mirrored by hand in [`client/src/connection.ts`](client/src/connection.ts) (the two are independent npm packages, so there's no shared build artifact to import from — both ends re-validate every message at runtime instead of trusting the wire).

```typescript
// Client -> Server
type ClientMessage =
  | { type: "join"; roomId: string; clientId: string }
  | { type: "cursor"; seq: number; x: number; y: number; t: number }
  | { type: "reaction"; seq: number; kind: "emoji"; emoji: string; x: number; y: number; t: number }
  | { type: "ping" };

// Server -> Client
type ServerMessage =
  | { type: "snapshot"; clients: Array<{ clientId: string; x: number; y: number }> }
  | { type: "peer_joined"; clientId: string }
  | { type: "peer_left"; clientId: string }
  | { type: "cursor"; clientId: string; seq: number; x: number; y: number; t: number }
  | { type: "reaction"; clientId: string; kind: "emoji"; emoji: string; x: number; y: number; t: number }
  | { type: "pong" }
  | { type: "error"; reason: string };
```

Key decisions:

- **Per-client `seq`, not a global counter.** Each remote client's `lastSeq` is tracked independently server-side (in `Room`); any incoming `seq` at or below that is dropped as stale/out-of-order. No reorder queue, no head-of-line blocking between clients — just an int comparison.
- **`t` is the client's send timestamp**, not server receive time or arrival time. The interpolation buffer needs "where was this cursor at real time T", and network jitter would corrupt that if we used arrival time instead.
- **Reactions are a distinct message type from cursor moves.** They're rendered as one-shot bursts that fade out, never smoothed or interpolated — smoothing a reaction would just make it feel laggy for no benefit, since it isn't continuous motion.
- **New client mid-session → `join` + `snapshot`, not event replay.** The server has no history log; a `snapshot` just reports current positions of everyone already in the room. Simplest correct answer, and trivially defensible: there's no replay ordering to get wrong.
- **All messages are schema-validated on both ends** (`parseClientMessage` / `parseServerMessage`). Anything that doesn't parse is dropped (client) or answered with `{type:"error"}` (server) — never crashes either side.

## Throttling

Raw `mousemove` fires 60–120Hz in most browsers. Broadcasting every event would mean, per remote peer, up to 120 JSON messages/sec at ~50-70 bytes each — a single 4-person room would be pushing on the order of 30-50 KB/s in cursor traffic alone for no perceptible smoothness gain, since a viewer can't distinguish 120Hz motion from ~25Hz interpolated motion once buffered interpolation is smoothing between points anyway.

**Chosen rate: ~25Hz, gated at 40ms via `requestAnimationFrame`** (`client/src/connection.ts`, `SEND_INTERVAL_MS = 40`), combined with a "send early if moved > 4px" escape hatch (`MIN_MOVE_PX = 4`) so a fast flick isn't held back a full 40ms tick and made to look laggy on direction changes.

Why 25Hz and not something lower like 10Hz or higher like 60Hz:
- 25Hz (40ms) is comfortably under the ~33-50ms range in the assignment brief, and lines up with the 120ms render delay used for interpolation — at least 3 samples land inside any given render window, which is enough for the bracket-interpolation to always have two real points to work between rather than falling back to "last known position."
- Going lower (10-15Hz) starts to show visible stepping once you're also holding a 120ms render delay, because gaps between real samples get close to the render delay itself.
- Going higher (60Hz+) roughly doubles bandwidth for a smoothness improvement that buffered interpolation already erases — the bottleneck for perceived smoothness is the render delay/interpolation, not the send rate, once you're above ~20Hz.

The live bandwidth readout (`netstats.ts`, described below) shows the actual effect: naive (unthrottled, estimated at 100Hz) vs. actual bytes/sec side by side in the header.

## State ownership

- **Server** (`server/src/room.ts`) holds only: current cursor position per client (for building snapshots) and room membership. No history buffer, no replay log, no persistence — a restart drops all rooms.
- **Client** (`client/src/interpolation.ts`, `App.tsx`) holds: a capped 5-entry interpolation buffer per remote peer, and its own cursor position rendered immediately with zero delay (local prediction — you never wait on a round trip to see your own mouse move).

## Interpolation strategy

Buffered interpolation, not raw lerp-to-latest. Each remote cursor renders **120ms in the past** (`DEFAULT_RENDER_DELAY_MS` in `client/src/interpolation.ts`), interpolating between the two buffered points whose timestamps bracket `now - 120ms`. If no bracket exists yet (buffer too sparse, or all points too new), it falls back to the last known real position — it never extrapolates into positions that haven't actually been reported.

**Tradeoff, stated explicitly: +120ms of perceived latency for zero snapping/teleporting.** A raw "lerp to latest received point" approach would look smoother in the best case but visibly stutter/teleport under any jitter or reordering, since it has no cushion of buffered history to interpolate through. The render-delay slider in the UI (0-400ms) makes this tradeoff tunable and visible live — dragging it to 0 with network chaos enabled reproduces the teleporting this design avoids.

Buffer is capped at 5 entries (`BUFFER_CAP`) — enough to always have a bracket at 25Hz send rate / 120ms delay, without unbounded growth.

## Disconnect / reconnect / heartbeat

- Server pings every connected socket every ~15s (`server/src/server.ts`, `HEARTBEAT_INTERVAL_MS`) using native WebSocket ping frames. A client that hasn't answered with a pong by the next sweep (~30s total) is terminated, which fires the `close` handler, removes it from the room, and broadcasts `peer_left`.
- Client keeps a stable `clientId` in `sessionStorage` (`getOrCreateClientId` in `connection.ts`) that survives reconnects and page reloads within a tab. Deliberately `sessionStorage`, not `localStorage` — `localStorage` is shared across tabs in the same browser, which would give every tab you open to test multiplayer the *same* `clientId`, and the server's resume logic would then treat the second tab's join as reclaiming the first tab's session instead of a new peer.
- On reconnect (exponential backoff, capped at 10s), the client re-sends `join` with the same `clientId`. The server's `Room.join` treats a `join` from an already-known `clientId` as a **resume** — it overwrites the stored socket/state in place rather than creating a duplicate peer entry.

## Failure handling

- **Out-of-order / stale delivery**: handled by the per-client `seq` check in `Room.cursor`/`Room.reaction` — anything `<= lastSeq` is silently dropped.
- **Malformed / unknown messages**: `parseClientMessage`/`parseServerMessage` reject anything that doesn't match the schema exactly (wrong types, missing fields, unknown `type`). Server responds with `{type:"error"}`; client just ignores the message. Neither side throws.
- **Disconnect mid-session**: detected via `close`/`error` WebSocket events (immediate) or the heartbeat timeout (up to ~30s, for a network drop that doesn't cleanly close the socket). Either path removes the client from its room and broadcasts `peer_left`.
- **Reconnect**: see above — same `clientId`, server-side resume, no duplicate-peer bug.

## Differentiators implemented

1. **Live network chaos toggle** (`client/src/connection.ts`, UI in `App.tsx`) — a symmetric `{enabled, delayMs, dropRate}` config applied to both the client's own send and receive paths via `setTimeout` + `Math.random()` drop checks. Not devtools-dependent; works the same in any browser, and demonstrates the interpolation/loss-handling live without needing to explain devtools throttling.
2. **Live bandwidth readout** (`client/src/netstats.ts`) — rolling 1-second window comparing naive (unthrottled, estimated at 100Hz × ~64 bytes/msg) vs. actual measured bytes/sec, shown live in the header.

Not implemented (out of scope given time available — see "Known limitations"): adaptive throttling by measured RTT, horizontal scaling write-up, `ARCHITECTURE.md`'s "alternatives considered" section is included below instead as it was cheap and high-signal.

## Known limitations

- No persistence — server state (room membership, positions) is entirely in-memory and lost on restart.
- No horizontal scaling — single process, single room map. See "alternatives considered" in `ARCHITECTURE.md` for the sketch of how this would shard by `roomId`.
- No authentication/authorization — any client can join any `roomId` and claim any `clientId`; a malicious client can also spoof someone else's `clientId` and hijack their session on reconnect. Fine for a demo, not for production.
- No adaptive throttling — send rate is fixed at ~25Hz regardless of measured RTT.
- Rooms are only cleaned up when they become empty via normal disconnect; a process that never sees `close`/`error` fire (rare, but possible under certain proxy/load-balancer configurations) would leak a room until the heartbeat timeout catches it (worst case ~30s, not indefinitely).


## Time spent

~3-4 hours end-to-end: protocol + validation, server room/heartbeat logic, client connection/throttle/reconnect logic, interpolation buffer, canvas rendering, chaos toggle + bandwidth readout, and this documentation.
