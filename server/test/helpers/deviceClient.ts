import { connect } from 'node:net';
import type { Socket } from 'node:net';
import type { GatewayMessage } from '@lionscope/protocol';

/** A raw TCP client standing in for the in-app SDK: records every line the gateway sends. */
export class DeviceClient {
  readonly received: GatewayMessage[] = [];
  readonly closed: Promise<void>;
  private buffer = '';
  private waiters: { predicate: (message: GatewayMessage) => boolean; resolve: () => void }[] = [];

  private constructor(readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf('\n');
      while (newline !== -1) {
        const message = JSON.parse(this.buffer.slice(0, newline)) as GatewayMessage;
        this.buffer = this.buffer.slice(newline + 1);
        this.received.push(message);
        this.waiters = this.waiters.filter((waiter) => {
          if (!waiter.predicate(message)) return true;
          waiter.resolve();
          return false;
        });
        newline = this.buffer.indexOf('\n');
      }
    });
    socket.on('error', () => undefined);
    this.closed = new Promise((resolve) => socket.once('close', () => resolve()));
  }

  static open(port: number): Promise<DeviceClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => resolve(new DeviceClient(socket)));
      socket.once('error', reject);
    });
  }

  /** Send raw text (no newline added). */
  write(text: string | Buffer): void {
    if (!this.socket.destroyed) this.socket.write(text);
  }

  /** Send one JSON line. */
  send(message: unknown): void {
    this.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
  }

  /** Resolves once a message matching `predicate` was received (or already had been). */
  waitFor(predicate: (message: GatewayMessage) => boolean): Promise<void> {
    if (this.received.some(predicate)) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ predicate, resolve }));
  }

  get isClosed(): boolean {
    return this.socket.destroyed;
  }

  close(): void {
    this.socket.end();
  }
}
