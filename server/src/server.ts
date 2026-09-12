import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { parseClientMessage } from "./protocol.js";
import { RoomManager } from "./room.js";

const PORT = Number(process.env.PORT ?? 8080);
const HEARTBEAT_INTERVAL_MS = 15_000;

const rooms = new RoomManager();

// A bare `new WebSocketServer({ port })` opens its own internal HTTP server
// that only understands the Upgrade handshake — a platform health check
// hitting `/` with a plain GET would hang. Running our own HTTP server
// alongside it (attached via `{ server }`) lets us answer that GET while
// WebSocket upgrades still go to `wss`.
const httpServer = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("multiplayer-sync server ok");
});
const wss = new WebSocketServer({ server: httpServer });

interface ConnMeta {
  roomId: string;
  clientId: string;
}

// Per-socket join state. A socket that hasn't sent `join` yet has no entry.
const connMeta = new WeakMap<WebSocket, ConnMeta>();

wss.on("connection", (ws: WebSocket) => {
  ws.on("message", (data) => {
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      send(ws, { type: "error", reason: "malformed json" });
      return;
    }

    const msg = parseClientMessage(raw);
    if (!msg) {
      send(ws, { type: "error", reason: "unrecognized or invalid message" });
      return;
    }

    if (msg.type === "join") {
      const room = rooms.getOrCreate(msg.roomId);
      room.join(msg.clientId, ws);
      connMeta.set(ws, { roomId: msg.roomId, clientId: msg.clientId });
      return;
    }

    if (msg.type === "ping") {
      send(ws, { type: "pong" });
      return;
    }

    // cursor / reaction require an established join first.
    const meta = connMeta.get(ws);
    if (!meta) {
      send(ws, { type: "error", reason: "must join before sending cursor/reaction" });
      return;
    }
    const room = rooms.get(meta.roomId);
    if (!room) return;

    if (msg.type === "cursor") {
      room.cursor(meta.clientId, msg.seq, msg.x, msg.y, msg.t);
    } else if (msg.type === "reaction") {
      room.reaction(meta.clientId, msg.seq, msg.emoji, msg.x, msg.y, msg.t);
    }
  });

  ws.on("pong", () => {
    const meta = connMeta.get(ws);
    if (meta) rooms.get(meta.roomId)?.markPong(meta.clientId);
  });

  const cleanup = () => {
    const meta = connMeta.get(ws);
    if (!meta) return;
    const room = rooms.get(meta.roomId);
    room?.leave(meta.clientId, ws);
    if (room) rooms.cleanupIfEmpty(meta.roomId);
    connMeta.delete(ws);
  };

  ws.on("close", cleanup);
  ws.on("error", cleanup);
});

function send(ws: WebSocket, msg: { type: string; [k: string]: unknown }): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// Server-initiated heartbeat: ping every connected client every ~15s. A
// client that misses the pong before the next sweep gets terminated (~30s
// total to detect a dead connection), which triggers the 'close' handler
// and a peer_left broadcast.
setInterval(() => {
  for (const room of rooms.allRooms()) {
    room.heartbeatSweep();
  }
}, HEARTBEAT_INTERVAL_MS);

httpServer.listen(PORT, () => {
  console.log(`multiplayer-sync server listening on ws://localhost:${PORT}`);
});
