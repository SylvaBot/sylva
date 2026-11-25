// The dashboard's live connection to its channel. It connects as a feed,
// asks for everything after the last event it has seen, and reconnects on its
// own with backoff. Like Cortex, it never interrupts the streamer for a
// reconnect: the dashboard only shows a quiet line while it is down.

import { api, type AlertState, type SylvaEvent } from './api';

export interface Handlers {
  event(e: SylvaEvent): void;
  state(s: AlertState): void;
  connected(up: boolean): void;
}

export function connect(key: string, lastSeq: number, on: Handlers): () => void {
  let ws: WebSocket | null = null;
  let seen = lastSeq;
  let backoff = 500;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    if (stopped) return;
    ws = new WebSocket(api.socketUrl(key));
    ws.onopen = () => ws?.send(JSON.stringify({ type: 'hello', role: 'feed', lastSeq: seen }));
    ws.onmessage = (m) => {
      const f = JSON.parse(String(m.data));
      if (f.type === 'event') {
        if (f.seq <= seen) return;
        seen = f.seq;
        on.event(f as SylvaEvent);
      } else if (f.type === 'ready') {
        backoff = 500;
        on.connected(true);
        on.state(f.state);
      } else if (f.type === 'state') {
        on.state(f as AlertState);
      }
    };
    ws.onclose = () => {
      if (stopped) return;
      on.connected(false);
      retry = setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 10000);
    };
  };

  // Keepalive. The server's runtime answers it without waking the channel.
  const ping = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}');
  }, 30000);

  open();
  return () => {
    stopped = true;
    clearTimeout(retry);
    clearInterval(ping);
    ws?.close(1000);
  };
}
