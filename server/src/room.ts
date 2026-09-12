import type { WebSocket } from "ws";
import type { ServerMessage } from "./protocol.js";

interface RoomClient {
  clientId: string;
  ws: WebSocket;
  x: number;
  y: number;
  // One counter per client, shared across cursor + reaction messages (both
  // carry `seq` in the same stream) — anything <= lastSeq is stale/out of
  // order and gets dropped. No reorder queue needed.
  lastSeq: number;
  isAlive: boolean;
}

export class Room {
  readonly roomId: string;
  private readonly clients = new Map<string, RoomClient>();

  constructor(roomId: string) {
    this.roomId = roomId;
  }

  get size(): number {
    return this.clients.size;
  }

  private send(client: RoomClient, msg: ServerMessage): void {
    if (client.ws.readyState === client.ws.OPEN) {
      client.ws.send(JSON.stringify(msg));
    }
  }

  // O(n) fan-out: one JSON.stringify, one pass over connected clients.
  private broadcast(msg: ServerMessage, exceptClientId?: string): void {
    const payload = JSON.stringify(msg);
    for (const client of this.clients.values()) {
      if (client.clientId === exceptClientId) continue;
      if (client.ws.readyState === client.ws.OPEN) {
        client.ws.send(payload);
      }
    }
  }

  /** Handles both a fresh join and a reconnect-resume for a known clientId. */
  join(clientId: string, ws: WebSocket): void {
    const existing = this.clients.get(clientId);
    if (existing) {
      // Resume: same clientId reconnecting. Overwrite the socket/state
      // rather than treating it as a duplicate peer.
      existing.ws = ws;
      existing.isAlive = true;
      this.send(existing, {
        type: "snapshot",
        clients: this.snapshotExcluding(clientId),
      });
      return;
    }

    const client: RoomClient = { clientId, ws, x: 0, y: 0, lastSeq: 0, isAlive: true };
    this.clients.set(clientId, client);

    this.send(client, { type: "snapshot", clients: this.snapshotExcluding(clientId) });
    this.broadcast({ type: "peer_joined", clientId }, clientId);
  }

  private snapshotExcluding(clientId: string): Array<{ clientId: string; x: number; y: number }> {
    const out: Array<{ clientId: string; x: number; y: number }> = [];
    for (const c of this.clients.values()) {
      if (c.clientId !== clientId) out.push({ clientId: c.clientId, x: c.x, y: c.y });
    }
    return out;
  }

  cursor(clientId: string, seq: number, x: number, y: number, t: number): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    if (seq <= client.lastSeq) return; // stale / out-of-order — drop
    client.lastSeq = seq;
    client.x = x;
    client.y = y;
    this.broadcast({ type: "cursor", clientId, seq, x, y, t }, clientId);
  }

  reaction(clientId: string, seq: number, emoji: string, x: number, y: number, t: number): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    if (seq <= client.lastSeq) return;
    client.lastSeq = seq;
    this.broadcast({ type: "reaction", clientId, kind: "emoji", emoji, x, y, t }, clientId);
  }

  markPong(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) client.isAlive = true;
  }

  /** Heartbeat sweep: ping everyone, terminate anyone who missed the previous pong. */
  heartbeatSweep(): void {
    for (const client of this.clients.values()) {
      if (!client.isAlive) {
        client.ws.terminate();
        continue; // 'close' handler will call leave()
      }
      client.isAlive = false;
      if (client.ws.readyState === client.ws.OPEN) {
        client.ws.ping();
      }
    }
  }

  /**
   * `ws` identifies which socket is asking to leave. A resumed session
   * (same clientId, new socket after reconnect) replaces the stored socket
   * in place — so if the *old*, now-superseded socket's close/error event
   * fires belatedly, it must not evict the session the new socket already
   * resumed. Only remove/broadcast if the caller's socket is still the one
   * on record.
   */
  leave(clientId: string, ws: WebSocket): void {
    const client = this.clients.get(clientId);
    if (!client || client.ws !== ws) return;
    this.clients.delete(clientId);
    this.broadcast({ type: "peer_left", clientId });
  }
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();

  getOrCreate(roomId: string): Room {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Room(roomId);
      this.rooms.set(roomId, room);
    }
    return room;
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  /** Drop empty rooms so the map doesn't grow unbounded over server lifetime. */
  cleanupIfEmpty(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room && room.size === 0) this.rooms.delete(roomId);
  }

  allRooms(): IterableIterator<Room> {
    return this.rooms.values();
  }
}
