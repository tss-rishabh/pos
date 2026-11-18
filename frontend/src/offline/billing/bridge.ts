import {
  ipcReplySchema,
  ipcResponseSchemas,
  type IpcChannel,
  type IpcRequest,
  type IpcResponse,
} from './contracts';

/** Exposed by frontend/electron/preload.cjs through contextBridge. Absent in
 * web browsers: web clients need internet to bill. */
export interface DesktopOfflineBridge {
  version: 1;
  invoke(channel: IpcChannel, payload: unknown): Promise<unknown>;
  onStatusChanged(listener: () => void): () => void;
}
declare global {
  interface Window {
    souledOfflineBilling?: DesktopOfflineBridge;
  }
}

export class OfflineBillingClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function desktopOfflineBridge(): DesktopOfflineBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = window.souledOfflineBilling;
  return bridge && bridge.version === 1 && typeof bridge.invoke === 'function' ? bridge : null;
}

export function offlineBillingClient(bridge: DesktopOfflineBridge) {
  return {
    async call<C extends IpcChannel>(channel: C, payload: IpcRequest<C>): Promise<IpcResponse<C>> {
      let raw: unknown;
      try {
        raw = await bridge.invoke(channel, payload);
      } catch {
        throw new OfflineBillingClientError(
          'OFFLINE_BILLING_STARTING',
          'Offline billing is starting on this device. Try again in a moment.',
        );
      }
      const reply = ipcReplySchema.safeParse(raw);
      if (!reply.success)
        throw new OfflineBillingClientError(
          'INVALID_REPLY',
          'Offline billing returned an invalid reply.',
        );
      if (!reply.data.ok)
        throw new OfflineBillingClientError(reply.data.error.code, reply.data.error.message);
      const data = ipcResponseSchemas[channel].safeParse(reply.data.data);
      if (!data.success)
        throw new OfflineBillingClientError(
          'INVALID_REPLY',
          'Offline billing returned an invalid reply.',
        );
      return data.data as IpcResponse<C>;
    },
    onStatusChanged: (listener: () => void) => bridge.onStatusChanged(listener),
  };
}
export type OfflineBillingClient = ReturnType<typeof offlineBillingClient>;
