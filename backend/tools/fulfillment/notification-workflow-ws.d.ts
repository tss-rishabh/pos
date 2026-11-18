/** The fixture uses this bounded surface of the installed ws runtime only. */
declare module 'ws' {
  import type { ClientRequest, IncomingMessage } from 'node:http';
  import type { Buffer } from 'node:buffer';
  interface NotificationSocketEvents {
    open: [];
    message: [data: Buffer];
    close: [code: number, reason: Buffer];
    error: [error: Error];
    'unexpected-response': [request: ClientRequest, response: IncomingMessage];
  }
  export default class WebSocket {
    constructor(address: string, options: { headers: Record<string, string> });
    on<K extends keyof NotificationSocketEvents>(
      event: K,
      listener: (...args: NotificationSocketEvents[K]) => void,
    ): this;
    once<K extends keyof NotificationSocketEvents>(
      event: K,
      listener: (...args: NotificationSocketEvents[K]) => void,
    ): this;
    terminate(): void;
  }
}
