import { request } from 'node:http';
import { connect } from 'node:net';
import { WS_PATH } from '@lionscope/protocol';
import type { ServerMessage } from '@lionscope/protocol';
import { WebSocket } from 'ws';

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Raw HTTP request (the path is sent verbatim, so traversal attempts aren't normalized away). */
export function rawRequest(
  port: number,
  rawPath: string,
  method = 'GET',
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: rawPath, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Attempt a WebSocket handshake; resolves with the response head (status line + headers). */
export function handshakeResponse(
  port: number,
  headers: Record<string, string>,
  pathname = WS_PATH,
): Promise<{ status: number; head: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      const lines = [
        `GET ${pathname} HTTP/1.1`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        '',
        '',
      ];
      socket.write(lines.join('\r\n'));
    });
    let data = '';
    socket.on('data', (chunk) => {
      data += String(chunk);
      const end = data.indexOf('\r\n\r\n');
      const match = /^HTTP\/1\.1 (\d{3})/.exec(data);
      if (end !== -1 && match) {
        resolve({ status: Number(match[1]), head: data.slice(0, end) });
        socket.destroy();
      }
    });
    socket.on('error', reject);
  });
}

/** Attempt a WebSocket handshake; resolves with the HTTP status of a rejection or 101. */
export async function handshakeStatus(
  port: number,
  headers: Record<string, string>,
  pathname = WS_PATH,
): Promise<number> {
  return (await handshakeResponse(port, headers, pathname)).status;
}

type Of<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

/** A `ws` client that records every message and can wait for specific ones. */
export class Client {
  readonly messages: ServerMessage[] = [];
  private waiters: { predicate: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as ServerMessage;
      this.messages.push(message);
      this.waiters = this.waiters.filter((waiter) => {
        if (!waiter.predicate(message)) return true;
        waiter.resolve(message);
        return false;
      });
    });
  }

  static open(port: number, origin = `http://localhost:${port}`): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, { origin });
    const client = new Client(ws);
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
    });
  }

  /** Resolves with the first message (already received or future) of `type` matching `predicate`. */
  waitFor<T extends ServerMessage['type']>(
    type: T,
    predicate: (message: Of<T>) => boolean = () => true,
  ): Promise<Of<T>> {
    const matches = (message: ServerMessage): message is Of<T> =>
      message.type === type && predicate(message as Of<T>);
    const existing = this.messages.find(matches);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      this.waiters.push({ predicate: matches, resolve: (message) => resolve(message as Of<T>) });
    });
  }

  /** Like waitFor, but only considers messages received after this call. */
  next<T extends ServerMessage['type']>(
    type: T,
    predicate: (message: Of<T>) => boolean = () => true,
  ): Promise<Of<T>> {
    const seen = this.messages.length;
    return this.waitFor(type, (message) => this.messages.indexOf(message) >= seen && predicate(message));
  }

  closed(): Promise<number> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve(-1);
    return new Promise((resolve) => this.ws.once('close', (code) => resolve(code)));
  }

  send(payload: unknown): void {
    this.ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  close(): void {
    this.ws.close();
  }
}
