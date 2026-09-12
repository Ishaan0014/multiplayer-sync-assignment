import { useEffect, useMemo, useRef, useState } from "react";
import { Connection, getOrCreateClientId } from "./connection";
import { InterpolationBuffer } from "./interpolation";
import { NetStats } from "./netstats";
import { colorForClientId, pruneExpiredReactions, renderFrame, type PeerVisual, type ReactionBurst } from "./render";

const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:8080";
const EMOJIS = ["👍", "🎉", "❤️", "😂", "👀", "🔥"];

type Status = "connecting" | "open" | "closed";

function roomIdFromUrl(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("room") ?? "default";
}

// Minimal line-icon set (Feather-style: 1.5px stroke, no fill) so the UI
// reads as a crafted tool rather than leaning on emoji glyphs for chrome.
function IconCursor({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
    </svg>
  );
}

function IconSettings({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function IconLink({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function IconCheck({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peersRef = useRef<Map<string, PeerVisual>>(new Map());
  const reactionsRef = useRef<ReactionBurst[]>([]);
  const ownPositionRef = useRef<{ x: number; y: number } | null>(null);
  const netStatsRef = useRef(new NetStats());
  const reactionIdRef = useRef(0);
  const connectionRef = useRef<Connection | null>(null);

  const [roomId] = useState(roomIdFromUrl);
  const [status, setStatus] = useState<Status>("connecting");
  const [peerIds, setPeerIds] = useState<string[]>([]);
  const [chaosEnabled, setChaosEnabled] = useState(false);
  const [chaosDelay, setChaosDelay] = useState(150);
  const [chaosDrop, setChaosDrop] = useState(0.1);
  const [renderDelay, setRenderDelay] = useState(120);
  const [panelOpen, setPanelOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const [netSnapshot, setNetSnapshot] = useState({ naiveBytesPerSec: 0, actualSentBytesPerSec: 0, actualReceivedBytesPerSec: 0 });

  const clientId = useMemo(() => getOrCreateClientId(), []);

  useEffect(() => {
    const conn = new Connection({
      onSnapshot: (clients) => {
        for (const c of clients) {
          upsertPeer(c.clientId).push({ x: c.x, y: c.y, t: Date.now() });
        }
        syncPeerIds();
      },
      onPeerJoined: (id) => {
        upsertPeer(id);
        syncPeerIds();
      },
      onPeerLeft: (id) => {
        peersRef.current.delete(id);
        syncPeerIds();
      },
      onCursor: (id, _seq, x, y, t) => {
        upsertPeer(id).push({ x, y, t });
      },
      onReaction: (id, emoji, x, y, _t) => {
        void id;
        reactionIdRef.current += 1;
        reactionsRef.current.push({ id: reactionIdRef.current, emoji, x, y, spawnedAt: Date.now() });
      },
      onStatusChange: setStatus,
      onBytesSent: (b) => netStatsRef.current.recordSentBytes(b),
      onBytesReceived: (b) => netStatsRef.current.recordReceivedBytes(b),
    });

    function upsertPeer(id: string): InterpolationBuffer {
      let peer = peersRef.current.get(id);
      if (!peer) {
        peer = { clientId: id, buffer: new InterpolationBuffer(), color: colorForClientId(id) };
        peersRef.current.set(id, peer);
      }
      return peer.buffer;
    }

    function syncPeerIds() {
      setPeerIds(Array.from(peersRef.current.keys()));
    }

    connectionRef.current = conn;
    conn.connect(WS_URL, roomId);
    return () => conn.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // Keep the live connection's chaos config in sync with the UI controls.
  useEffect(() => {
    if (connectionRef.current) {
      connectionRef.current.chaos = { enabled: chaosEnabled, delayMs: chaosDelay, dropRate: chaosDrop };
    }
  }, [chaosEnabled, chaosDelay, chaosDrop]);

  // Canvas render loop + netstats readout, both driven by rAF independent
  // of message arrival so interpolation keeps animating between updates.
  useEffect(() => {
    let raf = 0;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let lastStatsUpdate = 0;

    const loop = () => {
      reactionsRef.current = pruneExpiredReactions(reactionsRef.current);
      renderFrame(ctx, canvas.width, canvas.height, {
        ownPosition: ownPositionRef.current,
        ownClientId: clientId,
        peers: peersRef.current,
        reactions: reactionsRef.current,
        renderDelayMs: renderDelay,
      });

      const now = Date.now();
      if (now - lastStatsUpdate > 250) {
        lastStatsUpdate = now;
        setNetSnapshot(netStatsRef.current.snapshot(now));
      }

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [clientId, renderDelay]);

  // Keep the canvas's pixel buffer sized to the viewport.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // Own cursor renders immediately — local prediction, no round-trip wait.
    ownPositionRef.current = { x, y };
    netStatsRef.current.recordRawMoveEvent();
    connectionRef.current?.onLocalMove(x, y);
  }

  function spawnReaction(emoji: string, x: number, y: number) {
    reactionIdRef.current += 1;
    reactionsRef.current.push({ id: reactionIdRef.current, emoji, x, y, spawnedAt: Date.now() });
    connectionRef.current?.sendReaction(emoji, x, y);
  }

  function handleCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    spawnReaction(EMOJIS[Math.floor(Math.random() * EMOJIS.length)], x, y);
  }

  function handleReactionPick(emoji: string) {
    const pos = ownPositionRef.current ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    spawnReaction(emoji, pos.x, pos.y);
  }

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — no-op, not worth surfacing an error for.
    }
  }

  const naiveRate = netSnapshot.naiveBytesPerSec;
  const actualRate = netSnapshot.actualSentBytesPerSec;
  const maxRate = Math.max(naiveRate, actualRate, 1);
  const savingsPct = naiveRate > 0 && actualRate > 0 ? Math.round((1 - actualRate / naiveRate) * 100) : null;

  return (
    <div className="app-shell">
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onClick={handleCanvasClick}
        className="canvas-layer"
      />

      <div className="hud">
        <div className="topbar panel">
          <div className="brand">
            <span className="brand-mark">
              <IconCursor size={13} />
            </span>
            Cursor Sync
          </div>

          <div className="divider" />

          <div className="status-pill">
            <span className={`status-dot status-dot--${status}`} />
            {status === "open" ? "Connected" : status === "connecting" ? "Connecting…" : "Disconnected"}
          </div>

          <div className="room-tag">
            room <strong>{roomId}</strong>
          </div>

          <div className="spacer" />

          <span className="row-value">{peerIds.length + 1} online</span>

          <div className="avatar-stack">
            {peerIds.slice(0, 5).map((id) => (
              <div
                key={id}
                className="avatar"
                style={{ background: colorForClientId(id) }}
                data-tip={id}
              >
                {id.slice(0, 2).toUpperCase()}
              </div>
            ))}
            {peerIds.length > 5 && <div className="avatar avatar--overflow">+{peerIds.length - 5}</div>}
            <div className="avatar avatar--you" data-tip={`you · ${clientId}`}>
              {clientId.slice(0, 2).toUpperCase()}
            </div>
          </div>

          <button className={`copy-btn${copied ? " is-copied" : ""}`} onClick={handleCopyLink}>
            {copied ? <IconCheck size={13} /> : <IconLink size={13} />}
            {copied ? "Copied" : "Copy invite link"}
          </button>

          <button
            className={`icon-btn${panelOpen ? " is-active" : ""}`}
            onClick={() => setPanelOpen((v) => !v)}
            title="Network & sync controls"
            aria-label="Toggle control panel"
          >
            <IconSettings size={14} />
          </button>
        </div>
      </div>

      {panelOpen && (
        <div className="side-panel-wrap">
          <div className="control-panel panel">
            <div className="panel-section">
              <div className="panel-section-title">Network simulation</div>
              <div className="row">
                <span className="row-label">Chaos mode</span>
                <label className="switch">
                  <input type="checkbox" checked={chaosEnabled} onChange={(e) => setChaosEnabled(e.target.checked)} />
                  <span className="switch-track" />
                </label>
              </div>

              {chaosEnabled && (
                <>
                  <div className="slider-row">
                    <div className="slider-row-head">
                      <span>Artificial delay</span>
                      <span className="row-value">{chaosDelay}ms</span>
                    </div>
                    <input
                      className="slider"
                      type="range"
                      min={0}
                      max={1000}
                      value={chaosDelay}
                      onChange={(e) => setChaosDelay(Number(e.target.value))}
                    />
                  </div>
                  <div className="slider-row">
                    <div className="slider-row-head">
                      <span>Packet drop</span>
                      <span className="row-value">{(chaosDrop * 100).toFixed(0)}%</span>
                    </div>
                    <input
                      className="slider"
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={chaosDrop}
                      onChange={(e) => setChaosDrop(Number(e.target.value))}
                    />
                  </div>
                </>
              )}
            </div>

            <div className="panel-section">
              <div className="panel-section-title">Interpolation</div>
              <div className="slider-row" style={{ marginTop: 0 }}>
                <div className="slider-row-head">
                  <span>Render delay</span>
                  <span className="row-value">{renderDelay}ms</span>
                </div>
                <input
                  className="slider"
                  type="range"
                  min={0}
                  max={400}
                  value={renderDelay}
                  onChange={(e) => setRenderDelay(Number(e.target.value))}
                />
              </div>
            </div>

            <div className="panel-section">
              <div className="panel-section-title">Live bandwidth</div>

              <div className="bw-bar-row">
                <div className="slider-row-head">
                  <span>Naive (unthrottled est.)</span>
                  <span className="row-value">{formatRate(naiveRate)}</span>
                </div>
                <div className="bw-bar-track">
                  <div className="bw-bar-fill bw-bar-fill--naive" style={{ width: `${(naiveRate / maxRate) * 100}%` }} />
                </div>
              </div>

              <div className="bw-bar-row">
                <div className="slider-row-head">
                  <span>Actual (throttled)</span>
                  <span className="row-value">{formatRate(actualRate)}</span>
                </div>
                <div className="bw-bar-track">
                  <div className="bw-bar-fill bw-bar-fill--actual" style={{ width: `${(actualRate / maxRate) * 100}%` }} />
                </div>
              </div>

              {savingsPct !== null && savingsPct > 0 && (
                <div className="bw-savings">~{savingsPct}% less bandwidth than raw mousemove</div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="reaction-dock panel">
        <span className="reaction-hint">react</span>
        {EMOJIS.map((emoji) => (
          <button key={emoji} className="reaction-btn" onClick={() => handleReactionPick(emoji)} aria-label={`Send ${emoji} reaction`}>
            {emoji}
          </button>
        ))}
      </div>

      {status === "open" && peerIds.length === 0 && (
        <div className="empty-hint">
          <div className="empty-hint-icon">
            <IconCursor size={26} />
          </div>
          <div className="empty-hint-title">You're the only one here</div>
          <div className="empty-hint-sub">Copy the invite link above and open it in another tab or share it with someone else to see cursors sync live.</div>
        </div>
      )}

      {status === "connecting" && (
        <div className="connecting-overlay">
          <div className="connecting-wrap">
            <div className="spinner" />
            <div className="connecting-label">Connecting to room "{roomId}"…</div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatRate(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
  return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
}
