import { C2S, decodeServer, encodeClient, S2C, type ClientMsg, type ServerMsg } from './protocol';

/**
 * Browser-side connection: binary WebSocket with automatic reconnect, a
 * round-trip-time probe and traffic counters for the debug HUD.
 */
export class NetClient {
  onMessage: ((m: ServerMsg) => void) | null = null;
  /** Fired on every (re)connect; the app re-sends Hello here. */
  onOpen: (() => void) | null = null;
  onClose: (() => void) | null = null;

  rttMs = 0;
  bytesIn = 0;
  bytesOut = 0;

  private ws: WebSocket | null = null;
  private pingTimer = 0;
  private closed = false;

  constructor(private readonly url: string) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.onOpen?.();
      this.pingTimer = window.setInterval(() => this.send({ op: C2S.Ping, t: performance.now() }), 2000);
    };
    ws.onmessage = (ev) => {
      const data = new Uint8Array(ev.data as ArrayBuffer);
      this.bytesIn += data.byteLength;
      let msg: ServerMsg;
      try {
        msg = decodeServer(data);
      } catch (err) {
        console.warn('dropped malformed packet', err);
        return;
      }
      if (msg.op === S2C.Pong) this.rttMs += (performance.now() - msg.t - this.rttMs) * (this.rttMs ? 0.3 : 1);
      else this.onMessage?.(msg);
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      this.onClose?.();
      if (!this.closed) setTimeout(() => this.connect(), 1500);
    };
  }

  send(m: ClientMsg): void {
    if (!this.connected) return;
    const bytes = encodeClient(m);
    this.bytesOut += bytes.byteLength;
    this.ws!.send(bytes);
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
