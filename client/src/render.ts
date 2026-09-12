// Canvas rendering: peer cursors (interpolated), own cursor (immediate, no
// delay/smoothing — local prediction), and reaction bursts (discrete,
// never smoothed, fade out over a fixed lifetime).
//
// The canvas itself is painted transparent (clearRect) each frame; the
// dot-grid backdrop is a CSS background on the <canvas> element (see
// styles.css) so it shows through without costing a per-frame redraw.

import { InterpolationBuffer, DEFAULT_RENDER_DELAY_MS } from "./interpolation";

export interface PeerVisual {
  clientId: string;
  buffer: InterpolationBuffer;
  color: string;
}

export interface ReactionBurst {
  id: number;
  emoji: string;
  x: number;
  y: number;
  spawnedAt: number;
}

const REACTION_LIFETIME_MS = 1200;

// 8 hues spaced ~45° apart around the wheel so any two peers are always
// tell-apart-at-a-glance distinct — the previous set had two near-identical
// oranges and a blue/cyan pair that read as the same color in motion.
const PALETTE = ["#fb7185", "#fb923c", "#fbbf24", "#4ade80", "#22d3ee", "#60a5fa", "#a78bfa", "#f472b6"];

export function colorForClientId(clientId: string): string {
  let hash = 0;
  for (let i = 0; i < clientId.length; i++) hash = (hash * 31 + clientId.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export function pruneExpiredReactions(reactions: ReactionBurst[], now: number = Date.now()): ReactionBurst[] {
  return reactions.filter((r) => now - r.spawnedAt < REACTION_LIFETIME_MS);
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCursor(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, label: string, isSelf: boolean): void {
  ctx.save();
  ctx.translate(x, y);

  // Soft glow behind the cursor glyph — punchy, not subtle.
  ctx.shadowColor = color;
  ctx.shadowBlur = isSelf ? 18 : 12;

  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 17);
  ctx.lineTo(4.8, 13.3);
  ctx.lineTo(8, 19.8);
  ctx.lineTo(10.4, 18.6);
  ctx.lineTo(7.2, 12.2);
  ctx.lineTo(12.4, 11.7);
  ctx.closePath();
  ctx.fillStyle = isSelf ? "#ffffff" : color;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = isSelf ? color : "rgba(11,10,20,0.5)";
  ctx.lineWidth = isSelf ? 2 : 1.4;
  ctx.stroke();

  // Fully rounded label pill.
  ctx.font = "700 11.5px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textBaseline = "middle";
  const paddingX = 9;
  const textWidth = ctx.measureText(label).width;
  const pillW = textWidth + paddingX * 2;
  const pillH = 21;
  const pillX = 16;
  const pillY = 12;

  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  roundRectPath(ctx, pillX, pillY, pillW, pillH, pillH / 2);
  ctx.fillStyle = isSelf ? color : "rgba(11, 10, 20, 0.85)";
  ctx.fill();
  ctx.shadowBlur = 0;
  if (!isSelf) {
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = `${color}88`;
    ctx.stroke();
  }

  ctx.fillStyle = isSelf ? "#0b0a14" : "#f8f7ff";
  ctx.fillText(label, pillX + paddingX, pillY + pillH / 2 + 0.5);

  ctx.restore();
}

function drawReaction(ctx: CanvasRenderingContext2D, r: ReactionBurst, now: number): void {
  const age = now - r.spawnedAt;
  const progress = Math.min(1, age / REACTION_LIFETIME_MS);

  // Quick pop-in (first 15% of lifetime), then drift up while fading out.
  const popIn = Math.min(1, age / (REACTION_LIFETIME_MS * 0.15));
  const overshoot = popIn < 1 ? 1 + Math.sin(popIn * Math.PI) * 0.35 : 1;
  const floatUp = progress * 46;
  const alpha = progress < 0.7 ? 1 : 1 - (progress - 0.7) / 0.3;
  const scale = overshoot * (1 + progress * 0.4);

  ctx.save();
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.font = `${26 * scale}px -apple-system, BlinkMacSystemFont, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.4)";
  ctx.shadowBlur = 8;
  ctx.fillText(r.emoji, r.x, r.y - floatUp);
  ctx.restore();
}

export interface RenderState {
  ownPosition: { x: number; y: number } | null;
  ownClientId: string;
  peers: Map<string, PeerVisual>;
  reactions: ReactionBurst[];
  renderDelayMs?: number;
}

export function renderFrame(ctx: CanvasRenderingContext2D, width: number, height: number, state: RenderState): void {
  const now = Date.now();
  ctx.clearRect(0, 0, width, height);

  for (const peer of state.peers.values()) {
    const pos = peer.buffer.getInterpolatedPosition(state.renderDelayMs ?? DEFAULT_RENDER_DELAY_MS, now);
    if (!pos) continue;
    drawCursor(ctx, pos.x, pos.y, peer.color, peer.clientId.slice(0, 6), false);
  }

  if (state.ownPosition) {
    drawCursor(ctx, state.ownPosition.x, state.ownPosition.y, colorForClientId(state.ownClientId), "you", true);
  }

  for (const r of state.reactions) {
    drawReaction(ctx, r, now);
  }
}
