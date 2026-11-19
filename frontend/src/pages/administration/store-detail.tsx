import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { captureOperatorScope, request, requestWithResponse } from '../../api/client';
import { ErrorState, Loading } from '../../components/common';
import { administrationIdentifier } from './api';
const text = z.string().nullable();
const detailSchema = z.object({
  id: administrationIdentifier,
  name: text,
  locationCode: text,
  phone: text,
  email: text,
  address: text,
  alternateAddress: text,
  city: text,
  state: text,
  pincode: text,
  type: z.string(),
  category: z.string(),
  active: z.boolean(),
  latitude: text,
  longitude: text,
  gstin: text,
  shortName: text,
  publicUrl: z.string(),
  franchise: z.object({ name: text, description: text, cin: text }).nullable(),
  pinelabMachines: z
    .array(
      z.object({
        id: administrationIdentifier,
        machineName: z.string(),
        merchantName: z.string(),
        clientId: z.string(),
        hardwareId: z.string(),
        imei: z.string(),
        tid: z.string(),
        merchantId: z.string(),
        merchantStorePosCode: z.string(),
      }),
    )
    .default([]),
  paytmMachines: z
    .array(
      z.object({
        id: administrationIdentifier,
        machineName: z.string(),
        merchantName: z.string(),
        mid: z.string(),
        tid: z.string(),
        channelId: z.string(),
        storeName: z.string(),
      }),
    )
    .default([]),
});
/** Terminal cards of the legacy store page (`stores/templates/stores/show.html:66-122`). */
function TerminalCard({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <section>
      <h3>{title}</h3>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value || '—'}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
export function StoreDetailDialog({
  operatorId,
  storeId,
  onClose,
}: {
  operatorId: string;
  storeId: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [problem, setProblem] = useState<unknown>(),
    [busy, setBusy] = useState(false),
    [imageFailed, setImageFailed] = useState(false);
  const detail = useQuery({
    queryKey: [operatorId, 'administration', 'store-detail', storeId],
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      const result = await request(
        `/api/v1/admin/stores/${storeId}/detail`,
        { operatorId, signal, cache: 'no-store' },
        detailSchema,
      );
      if (
        result.id !== storeId ||
        result.publicUrl !== `https://thesouledstore.com/?store_id=${storeId}`
      )
        throw new Error('The selected store details do not match.');
      return result;
    },
  });
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  async function download() {
    setBusy(true);
    setProblem(undefined);
    try {
      const signal = captureOperatorScope(operatorId),
        file = await requestWithResponse(
          `/api/v1/admin/stores/${storeId}/qr`,
          {
            operatorId,
            signal,
            cache: 'no-store',
            redirect: 'error',
            headers: { Accept: 'image/png' },
          },
          async (response) => {
            if (response.headers.get('Content-Type')?.split(';')[0] !== 'image/png')
              throw new Error('The store QR returned an unexpected format.');
            const reader = response.body?.getReader();
            if (!reader) throw new Error('The store QR is unavailable.');
            const chunks: Uint8Array<ArrayBuffer>[] = [];
            let length = 0;
            try {
              for (;;) {
                signal.throwIfAborted();
                const next = await reader.read();
                if (next.done) break;
                length += next.value.length;
                if (length > 1_000_000) throw new Error('The store QR exceeds its size limit.');
                chunks.push(Uint8Array.from(next.value));
              }
            } finally {
              await reader.cancel().catch(() => undefined);
              reader.releaseLock();
            }
            return new Blob(chunks, { type: 'image/png' });
          },
        );
      signal.throwIfAborted();
      const url = URL.createObjectURL(file),
        anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `store-${storeId}-qr.png`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setProblem(error);
    } finally {
      setBusy(false);
    }
  }
  const row = detail.data;
  return (
    <dialog
      ref={dialog}
      className="administration-dialog"
      aria-label="Store details"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <h2>Store details</h2>
      {detail.isPending ? (
        <Loading />
      ) : detail.isError ? (
        <ErrorState error={detail.error} />
      ) : (
        row && (
          <>
            <h3>
              {row.name} · {row.id}
            </h3>
            <p>
              {row.active ? 'Active' : 'Archived'} · {row.type} · {row.category}
            </p>
            {row.active && !imageFailed && (
              <img
                src={`/api/v1/admin/stores/${storeId}/image/content`}
                alt={`Store ${row.name ?? storeId}`}
                style={{ maxWidth: '100%' }}
                onError={() => setImageFailed(true)}
              />
            )}
            <dl>
              {[
                ['Location code', row.locationCode],
                ['Short name', row.shortName],
                ['Phone', row.phone],
                ['Email', row.email],
                ['Address', row.address],
                ['Alternate address', row.alternateAddress],
                ['City', row.city],
                ['State', row.state],
                ['Postal code', row.pincode],
                ['Latitude', row.latitude],
                ['Longitude', row.longitude],
                ['GSTIN', row.gstin],
                ['Franchise', row.franchise?.name],
                ['Franchise description', row.franchise?.description],
                ['Franchise CIN', row.franchise?.cin],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value || '—'}</dd>
                </div>
              ))}
            </dl>
            {row.pinelabMachines.map((machine) => (
              <TerminalCard
                key={`pinelab-${machine.id}`}
                title={`Pos Pinelab Terminal Details - ${machine.machineName}`}
                rows={[
                  ['Merchant Name', machine.merchantName],
                  ['Client Iid', machine.clientId],
                  ['Hardware Id', machine.hardwareId],
                  ['IMEI No', machine.imei],
                  ['TID', machine.tid],
                  ['Merchant Id', machine.merchantId],
                  ['Merchant Store Pos Code', machine.merchantStorePosCode],
                ]}
              />
            ))}
            {row.paytmMachines.map((machine) => (
              <TerminalCard
                key={`paytm-${machine.id}`}
                title={`Pos Paytm Terminal Details - ${machine.machineName}`}
                rows={[
                  ['Merchant Name', machine.merchantName],
                  ['Machine Name', machine.machineName],
                  ['Paytm MID', machine.mid],
                  ['Paytm TID', machine.tid],
                  ['Channel ID', machine.channelId],
                  ['Store Name', machine.storeName],
                ]}
              />
            ))}
            <section>
              <h3>Store marketing QR</h3>
              <p>{row.publicUrl}</p>
              <img
                src={`/api/v1/admin/stores/${storeId}/qr`}
                width={256}
                height={256}
                alt={`Marketing QR for ${row.name ?? storeId}`}
              />
              <button className="button secondary" disabled={busy} onClick={() => void download()}>
                Download store QR PNG
              </button>
            </section>
          </>
        )
      )}
      {problem !== undefined && <ErrorState error={problem} />}
      <button className="button secondary" disabled={busy} onClick={onClose}>
        Close store details
      </button>
    </dialog>
  );
}
