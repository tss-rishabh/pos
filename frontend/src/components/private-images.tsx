import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ApiError, request, captureOperatorScope } from '../api/client';
import { ErrorState } from './common';
import { fileChecksum, privateUploadSchema, uploadPrivateFile } from '../lib/private-upload';

type ImageKind = 'image' | 'cover-image';
export interface PrivateImageSlot {
  kind: ImageKind;
  label: string;
  exists: boolean;
  url: string;
  variant: 'portrait' | 'cover';
}
const reservationSchema = privateUploadSchema.extend({
  id: z.uuid(),
  expiresAt: z.number().positive(),
});
const types = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
interface Attachment {
  id: string;
  revision: string;
  expiresAt: number;
}

/** Upload once and retry attachment independently after a dropped response. Nothing is persisted. */
export function PrivateImages({
  title,
  revision,
  available,
  online,
  slots,
  reservePath,
  attachmentPath,
  attachmentSchema,
  onAttached,
  operatorId,
  editable = true,
}: {
  title: string;
  revision: string;
  available: boolean;
  online: boolean;
  slots: PrivateImageSlot[];
  reservePath: string;
  attachmentPath: (id: string) => string;
  attachmentSchema: z.ZodType<unknown>;
  onAttached: () => Promise<void>;
  operatorId?: string;
  editable?: boolean;
}) {
  const active = useRef<AbortController | null>(null),
    mounted = useRef(true);
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'attaching'>('idle'),
    [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState(''),
    [attachment, setAttachment] = useState<Attachment | null>(null),
    [broken, setBroken] = useState<Partial<Record<ImageKind, string>>>({});
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
      active.current = null;
    };
  }, []);
  const current = (controller: AbortController) =>
    mounted.current && active.current === controller && !controller.signal.aborted;
  const signal = (controller: AbortController) =>
    AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]);
  async function attach(pending: Attachment, controller: AbortController) {
    if (pending.expiresAt <= Date.now()) {
      setAttachment(null);
      throw new Error('This upload expired. Choose the image again.');
    }
    setPhase('attaching');
    await request(
      attachmentPath(pending.id),
      {
        method: 'POST',
        operatorId,
        cache: 'no-store',
        signal: signal(controller),
        body: JSON.stringify({ revision: pending.revision }),
      },
      attachmentSchema,
    );
    if (!current(controller)) return;
    setAttachment(null);
    setMessage('Image saved.');
    try {
      await onAttached();
    } catch {
      if (current(controller))
        throw new Error('Your image was saved. Reload this page to see the latest image.');
    }
  }
  async function run(action: (controller: AbortController) => Promise<void>) {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setError(null);
    setMessage('');
    let ownerScope: AbortSignal | undefined;
    const cancelOwner = () => controller.abort();
    try {
      if (!operatorId) throw new DOMException('The signed-in operator changed.', 'AbortError');
      ownerScope = captureOperatorScope(operatorId);
      ownerScope.addEventListener('abort', cancelOwner, { once: true });
      ownerScope.throwIfAborted();
      await action(controller);
    } catch (failure) {
      if (current(controller)) {
        if (failure instanceof ApiError && failure.status < 500 && failure.status !== 429) {
          setAttachment(null);
          if (failure.status === 409) await onAttached().catch(() => undefined);
        }
        setError(failure);
      }
    } finally {
      ownerScope?.removeEventListener('abort', cancelOwner);
      if (mounted.current && active.current === controller) {
        if (ownerScope?.aborted) {
          setAttachment(null);
          setError(new DOMException('The signed-in operator changed.', 'AbortError'));
        }
        setPhase('idle');
        active.current = null;
      }
    }
  }
  async function upload(file: File, kind: ImageKind, controller: AbortController) {
    if (!online || !available || !editable) throw new Error('This image cannot be changed.');
    if (!types.has(file.type) || file.size < 1 || file.size > 10 * 1024 * 1024)
      throw new Error('Choose a JPEG, PNG, WebP or GIF image smaller than 10 MB.');
    setAttachment(null);
    setPhase('uploading');
    const checksum = await fileChecksum(file, controller.signal);
    const reservation = await request(
      reservePath,
      {
        method: 'POST',
        operatorId,
        cache: 'no-store',
        signal: signal(controller),
        body: JSON.stringify({
          revision,
          upload: {
            id: crypto.randomUUID(),
            kind,
            name: file.name,
            contentType: file.type,
            size: file.size,
            checksum,
          },
        }),
      },
      reservationSchema,
    );
    await uploadPrivateFile(file, reservation, controller.signal, 120000);
    if (!current(controller)) return;
    const pending = { id: reservation.id, revision, expiresAt: reservation.expiresAt };
    setAttachment(pending);
    await attach(pending, controller);
  }
  const busy = phase !== 'idle';
  // One status for the current attempt. Once its attachment is confirmed the saved message
  // replaces the progress text, even while the follow-up reload still holds the controls.
  const status =
    message ||
    (phase === 'uploading'
      ? 'Uploading your image…'
      : phase === 'attaching'
        ? 'Checking and attaching your image…'
        : '');
  return (
    <section className="surface profile-images">
      <h2>{title}</h2>
      {slots.map((slot) => (
        <div key={slot.kind} className={`profile-image-slot ${slot.variant}`}>
          {available && slot.exists && online && broken[slot.kind] !== revision ? (
            <img
              alt={slot.label}
              src={slot.url}
              referrerPolicy="no-referrer"
              onError={() => setBroken((values) => ({ ...values, [slot.kind]: revision }))}
            />
          ) : (
            <div className="profile-image-placeholder" aria-label={`${slot.label} placeholder`} />
          )}
          <label>
            {slot.label}
            <input
              type="file"
              aria-label={`Change ${slot.label.toLowerCase()}`}
              accept="image/jpeg,image/png,image/webp,image/gif"
              disabled={!online || !available || !editable || busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void run((controller) => upload(file, slot.kind, controller));
              }}
            />
          </label>
        </div>
      ))}
      {!available && <p>Image uploads are currently unavailable.</p>}
      {status && <p role="status">{status}</p>}
      {attachment && !busy && (
        <p>Your upload is ready. Retry attaching it before choosing another image.</p>
      )}
      {attachment && (
        <button
          className="button secondary"
          disabled={!online || !available || !editable || busy}
          onClick={() => void run((controller) => attach(attachment, controller))}
        >
          Retry image attachment
        </button>
      )}
      {error !== null && <ErrorState error={error} />}
    </section>
  );
}
