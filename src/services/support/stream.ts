// ============================================================================
// SUPPORT — SSE PUB/SUB (in-memory)
// ----------------------------------------------------------------------------
// Real-time fan-out for the support chat. Team Chat used polling; there is no
// existing SSE/WebSocket transport to reuse (confirmed in recon), so we add a
// lightweight in-memory registry: subscribers (merchant widget + admin console)
// register an SSE response per conversation; appendMessage publishes to them.
//
// NOTE: this is per-process. Railway runs a SINGLE backend instance, so this is
// sufficient. If the service is ever scaled horizontally, swap this for a
// Redis pub/sub — the client-side `?since=` polling fallback keeps correctness
// either way.
// ============================================================================

export interface SseClient {
  write: (chunk: string) => void;
}

const channels = new Map<string, Set<SseClient>>();

/** Register an SSE client for a conversation. Returns an unsubscribe fn. */
export function subscribe(conversationId: string, client: SseClient): () => void {
  let set = channels.get(conversationId);
  if (!set) {
    set = new Set();
    channels.set(conversationId, set);
  }
  set.add(client);
  return () => {
    const s = channels.get(conversationId);
    if (!s) return;
    s.delete(client);
    if (s.size === 0) channels.delete(conversationId);
  };
}

/** Push a named event to every subscriber of a conversation. Never throws. */
export function publish(conversationId: string, event: string, data: unknown): void {
  const set = channels.get(conversationId);
  if (!set || set.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of set) {
    try {
      client.write(payload);
    } catch {
      /* a dead connection is cleaned up on its own 'close' handler */
    }
  }
}
