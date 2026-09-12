// Shared wire protocol for the multiplayer cursor-sync app.
// Mirrored (not imported) in client/src/connection.ts — the two packages
// build independently, so the type shapes are kept in sync by hand and
// re-validated at runtime on both ends.

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

const MAX_ROOM_ID_LEN = 128;
const MAX_CLIENT_ID_LEN = 128;
const MAX_EMOJI_LEN = 16;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyString(v: unknown, maxLen: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= maxLen;
}

// Runtime validation for anything arriving off the wire — untrusted input,
// so we never trust the TypeScript type alone. Malformed/unknown payloads
// are rejected rather than crashing the server.
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const msg = raw as Record<string, unknown>;

  switch (msg.type) {
    case "join":
      if (
        isNonEmptyString(msg.roomId, MAX_ROOM_ID_LEN) &&
        isNonEmptyString(msg.clientId, MAX_CLIENT_ID_LEN)
      ) {
        return { type: "join", roomId: msg.roomId, clientId: msg.clientId };
      }
      return null;

    case "cursor":
      if (isFiniteNumber(msg.seq) && isFiniteNumber(msg.x) && isFiniteNumber(msg.y) && isFiniteNumber(msg.t)) {
        return { type: "cursor", seq: msg.seq, x: msg.x, y: msg.y, t: msg.t };
      }
      return null;

    case "reaction":
      if (
        isFiniteNumber(msg.seq) &&
        msg.kind === "emoji" &&
        isNonEmptyString(msg.emoji, MAX_EMOJI_LEN) &&
        isFiniteNumber(msg.x) &&
        isFiniteNumber(msg.y) &&
        isFiniteNumber(msg.t)
      ) {
        return { type: "reaction", seq: msg.seq, kind: "emoji", emoji: msg.emoji, x: msg.x, y: msg.y, t: msg.t };
      }
      return null;

    case "ping":
      return { type: "ping" };

    default:
      return null;
  }
}
