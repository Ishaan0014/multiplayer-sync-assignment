// WebSocket transport: join/reconnect, seq-tagged send, throttling, and an
// optional network-chaos layer (artificial delay + drop) applied uniformly
// to both directions so it exercises the same interpolation/loss-handling
// path a real flaky network would.
//
// Message shapes mirror server/src/protocol.ts. Kept as a hand-written copy
// (not a shared import) since client and server are independent packages;
// re-validated at runtime on receipt so a shape drift fails safe instead of
// crashing the UI.

export type ClientMessage =
  | { type: "join"; roomId: string; clientId: string }
  | { type: "cursor"; seq: number; x: number; y: number; t: number }
  | { type: "reaction"; seq: number; kind: "emoji"; emoji: string; x: number; y: number; t: number }
  | { type: "ping" };

export type ServerMessage =
  | { type: "snapshot"; clients: Array<{ clientId: string; x: number; y: number }> }
  | { type: "peer_joined"; clientId: string }
  | { type: "peer_left"; clientId: string }
  | { type: "cursor"; clientId: string; seq: number; x: number; y: number; t: number }
  | { type: "reaction"; clientId: string; kind: "emoji"; emoji: string; x: number; y: number; t: number }
  | { type: "pong" }
  | { type: "error"; reason: string };

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const msg = raw as Record<string, unknown>;
  switch (msg.type) {
    case "snapshot":
      if (Array.isArray(msg.clients)) {
        return { type: "snapshot", clients: msg.clients as Array<{ clientId: string; x: number; y: number }> };
      }
      return null;
    case "peer_joined":
    case "peer_left":
      if (typeof msg.clientId === "string") return { type: msg.type, clientId: msg.clientId };
      return null;
    case "cursor":
      if (
        typeof msg.clientId === "string" &&
        isFiniteNumber(msg.seq) &&
        isFiniteNumber(msg.x) &&
        isFiniteNumber(msg.y) &&
        isFiniteNumber(msg.t)
      ) {
        return { type: "cursor", clientId: msg.clientId, seq: msg.seq, x: msg.x, y: msg.y, t: msg.t };
      }
      return null;
    case "reaction":
      if (
        typeof msg.clientId === "string" &&
        msg.kind === "emoji" &&
        typeof msg.emoji === "string" &&
        isFiniteNumber(msg.x) &&
        isFiniteNumber(msg.y)
      ) {
        return {
          type: "reaction",
          clientId: msg.clientId,
          kind: "emoji",
          emoji: msg.emoji,
          x: msg.x as number,
          y: msg.y as number,
          t: isFiniteNumber(msg.t) ? (msg.t as number) : Date.now(),
        };
      }
      return null;
    case "pong":
      return { type: "pong" };
    case "error":
      if (typeof msg.reason === "string") return { type: "error", reason: msg.reason };
      return null;
    default:
      return null;
  }
}

const CLIENT_ID_KEY = "multiplayer-sync:clientId";

// sessionStorage, not localStorage: it survives reload/reconnect within a
// tab (what "stable clientId across reconnects" needs) but is NOT shared
// across tabs. localStorage would give every tab in the same browser the
// *same* clientId, so opening two tabs to test multiplayer (per this repo's
// own README) would have the second tab's join be treated by the server as
// a resume of the first, silently stealing its connection.
export function getOrCreateClientId(): string {
  let id = sessionStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

/** Symmetric artificial-network config: same knobs apply to send and receive. */
export interface ChaosConfig {
  enabled: boolean;
  delayMs: number; // one-way artificial latency added
  dropRate: number; // 0..1 probability a message is silently dropped
}

export const DEFAULT_CHAOS: ChaosConfig = { enabled: false, delayMs: 0, dropRate: 0 };

export interface ConnectionHandlers {
  onSnapshot: (clients: Array<{ clientId: string; x: number; y: number }>) => void;
  onPeerJoined: (clientId: string) => void;
  onPeerLeft: (clientId: string) => void;
  onCursor: (clientId: string, seq: number, x: number, y: number, t: number) => void;
  onReaction: (clientId: string, emoji: string, x: number, y: number, t: number) => void;
  onStatusChange: (status: "connecting" | "open" | "closed") => void;
  /** Fired for every message actually written to the wire, post-chaos-drop, for bandwidth accounting. */
  onBytesSent: (bytes: number) => void;
  onBytesReceived: (bytes: number) => void;
}

// Client throttle: raw mousemove fires 60-120Hz, but we only ever want to
// emit ~20-30Hz onto the wire. Gate on whichever gives first: enough time
// elapsed, or the pointer moved far enough that waiting would look laggy.
const SEND_INTERVAL_MS = 40; // ~25Hz
const MIN_MOVE_PX = 4;

export class Connection {
  private ws: WebSocket | null = null;
  private roomId = "";
  readonly clientId: string;
  private seq = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private handlers: ConnectionHandlers;
  chaos: ChaosConfig = { ...DEFAULT_CHAOS };

  private lastSentAt = 0;
  private lastSentX = 0;
  private lastSentY = 0;
  private rafHandle: number | null = null;
  private pendingCursor: { x: number; y: number } | null = null;

  constructor(handlers: ConnectionHandlers, clientId: string = getOrCreateClientId()) {
    this.handlers = handlers;
    this.clientId = clientId;
  }

  connect(url: string, roomId: string): void {
    this.roomId = roomId;
    this.closedByUser = false;
    this.openSocket(url);
  }

  private openSocket(url: string): void {
    this.handlers.onStatusChange("connecting");
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.handlers.onStatusChange("open");
      this.rawSend({ type: "join", roomId: this.roomId, clientId: this.clientId });
    });

    ws.addEventListener("message", (event) => {
      this.simulateReceive(event.data as string);
    });

    ws.addEventListener("close", () => {
      this.handlers.onStatusChange("closed");
      if (!this.closedByUser) this.scheduleReconnect(url);
    });

    ws.addEventListener("error", () => {
      ws.close();
    });
  }

  private scheduleReconnect(url: string): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 10_000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket(url);
    }, delay);
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.ws?.close();
  }

  private simulateReceive(raw: string): void {
    const deliver = () => {
      if (this.chaos.enabled && Math.random() < this.chaos.dropRate) return; // simulated packet loss
      this.handlers.onBytesReceived(raw.length);
      this.handleMessage(raw);
    };
    if (this.chaos.enabled && this.chaos.delayMs > 0) {
      setTimeout(deliver, this.chaos.delayMs);
    } else {
      deliver();
    }
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const msg = parseServerMessage(parsed);
    if (!msg) return;

    switch (msg.type) {
      case "snapshot":
        this.handlers.onSnapshot(msg.clients);
        break;
      case "peer_joined":
        this.handlers.onPeerJoined(msg.clientId);
        break;
      case "peer_left":
        this.handlers.onPeerLeft(msg.clientId);
        break;
      case "cursor":
        this.handlers.onCursor(msg.clientId, msg.seq, msg.x, msg.y, msg.t);
        break;
      case "reaction":
        this.handlers.onReaction(msg.clientId, msg.emoji, msg.x, msg.y, msg.t);
        break;
      case "pong":
      case "error":
        break;
    }
  }

  /** Raw send, bypassing throttling — used for join/ping/reaction (never throttled). */
  private rawSend(msg: ClientMessage): void {
    const payload = JSON.stringify(msg);
    const write = () => {
      if (this.chaos.enabled && Math.random() < this.chaos.dropRate) return;
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(payload);
        this.handlers.onBytesSent(payload.length);
      }
    };
    if (this.chaos.enabled && this.chaos.delayMs > 0) {
      setTimeout(write, this.chaos.delayMs);
    } else {
      write();
    }
  }

  sendReaction(emoji: string, x: number, y: number): void {
    this.seq += 1;
    this.rawSend({ type: "reaction", seq: this.seq, kind: "emoji", emoji, x, y, t: Date.now() });
  }

  /**
   * Called on every raw mousemove (60-120Hz). Buffers the latest position
   * and, driven by rAF, actually writes to the wire only when >= 40ms have
   * elapsed since the last send OR the pointer moved more than 4px — so a
   * stationary-ish mouse doesn't spam the network, but a fast flick isn't
   * held back a full tick either.
   */
  onLocalMove(x: number, y: number): void {
    this.pendingCursor = { x, y };
    if (this.rafHandle === null) {
      this.rafHandle = requestAnimationFrame(this.flushCursor);
    }
  }

  private flushCursor = (): void => {
    this.rafHandle = null;
    const pending = this.pendingCursor;
    if (!pending) return;

    const now = performance.now();
    const dx = pending.x - this.lastSentX;
    const dy = pending.y - this.lastSentY;
    const movedFar = dx * dx + dy * dy > MIN_MOVE_PX * MIN_MOVE_PX;
    const elapsedEnough = now - this.lastSentAt >= SEND_INTERVAL_MS;

    if (elapsedEnough || movedFar) {
      this.lastSentAt = now;
      this.lastSentX = pending.x;
      this.lastSentY = pending.y;
      this.pendingCursor = null;
      this.seq += 1;
      this.rawSend({ type: "cursor", seq: this.seq, x: pending.x, y: pending.y, t: Date.now() });
    }

    // Keep polling at rAF rate while there's a pending move waiting on the gate.
    if (this.pendingCursor) {
      this.rafHandle = requestAnimationFrame(this.flushCursor);
    }
  };
}
