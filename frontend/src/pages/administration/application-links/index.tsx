import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Principal } from '../../../api/types';
import { captureOperatorScope, request } from '../../../api/client';
import { Empty, ErrorState, PageTitle } from '../../../components/common';
import { useOnline } from '../../../hooks/use-pos';
import {
  applicationBase,
  applicationCapabilitiesSchema,
  applicationDownloadSession,
  downloadApplicationBlob,
  issueCustomerQr,
  issueStaffQr,
  type CustomerApplicationQr,
  type StaffApplicationQr,
} from './api';
import '../styles.css';
export { ApplicationLinkLandingPage } from './landing';

interface ApplicationLinksProps {
  user: Principal;
  storeId?: string;
}
export function ApplicationLinksPage(props: ApplicationLinksProps) {
  return <ApplicationLinkWorkspace key={props.user.id + ':' + (props.storeId || '')} {...props} />;
}
function ApplicationLinkWorkspace({ user, storeId = '' }: ApplicationLinksProps) {
  const online = useOnline(),
    lifetime = useRef(new AbortController()),
    [staffQr, setStaffQr] = useState<(StaffApplicationQr & { receivedAt: number }) | null>(null),
    [customerQr, setCustomerQr] = useState<CustomerApplicationQr | null>(null),
    [remaining, setRemaining] = useState(0),
    [busy, setBusy] = useState<'staff' | 'customer' | 'download' | null>(null),
    [error, setError] = useState<unknown>(),
    download = useRef<ReturnType<typeof applicationDownloadSession> | null>(null),
    lastRenewed = useRef<string | null>(null);
  const meta = useQuery({
    queryKey: [user.id, 'application-links', storeId],
    enabled: online,
    queryFn: ({ signal }) =>
      request(
        applicationBase + '/capabilities',
        { operatorId: user.id, signal, cache: 'no-store', redirect: 'error' },
        applicationCapabilitiesSchema,
      ),
    retry: false,
  });
  useEffect(() => {
    if (lifetime.current.signal.aborted) lifetime.current = new AbortController();
    const scope = lifetime.current;
    return () => scope.abort();
  }, []);
  async function generate(kind: 'staff' | 'customer') {
    if (!online || busy) return;
    setBusy(kind);
    setError(undefined);
    try {
      const signal = AbortSignal.any([lifetime.current.signal, captureOperatorScope(user.id)]);
      if (kind === 'staff') {
        const value = await issueStaffQr(user.id, crypto.randomUUID(), signal);
        signal.throwIfAborted();
        download.current = applicationDownloadSession(new URL(value.url).hash.slice(1));
        setStaffQr({ ...value, receivedAt: Date.now() });
      } else {
        const value = await issueCustomerQr(user.id, signal);
        signal.throwIfAborted();
        setCustomerQr(value);
      }
    } catch (failure) {
      if (!lifetime.current.signal.aborted) setError(failure);
    } finally {
      if (!lifetime.current.signal.aborted) setBusy(null);
    }
  }
  useEffect(() => {
    if (!staffQr) return;
    const update = () =>
      setRemaining(
        Math.max(0, staffQr.expiresAt - staffQr.serverNow - (Date.now() - staffQr.receivedAt)),
      );
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [staffQr]);
  useEffect(() => {
    if (
      staffQr &&
      remaining === 0 &&
      Date.now() - staffQr.receivedAt >= staffQr.expiresAt - staffQr.serverNow &&
      online &&
      !busy &&
      lastRenewed.current !== staffQr.id
    ) {
      lastRenewed.current = staffQr.id;
      void generate('staff');
    }
  });
  async function downloadStaff() {
    if (!download.current || busy || !online) return;
    setBusy('download');
    setError(undefined);
    try {
      const signal = AbortSignal.any([lifetime.current.signal, captureOperatorScope(user.id)]),
        blob = await download.current(signal);
      signal.throwIfAborted();
      downloadApplicationBlob(blob, 'mpos.apk');
    } catch (failure) {
      if (!lifetime.current.signal.aborted) setError(failure);
    } finally {
      if (!lifetime.current.signal.aborted) setBusy(null);
    }
  }
  function saveCustomerQr() {
    if (!customerQr) return;
    try {
      captureOperatorScope(user.id);
      const bytes = Uint8Array.from(atob(customerQr.qrDataUrl.split(',')[1]!), (character) =>
        character.charCodeAt(0),
      );
      downloadApplicationBlob(
        new Blob([bytes], { type: 'image/png' }),
        'customer-application-qr.png',
      );
    } catch (failure) {
      setError(failure);
    }
  }
  const urgency =
    remaining < Math.floor((meta.data?.qrPeriodSeconds || 60) / 3) * 1000
      ? 'red'
      : remaining < Math.floor((meta.data?.qrPeriodSeconds || 60) / 3) * 2000
        ? 'orange'
        : 'green';
  if (![1, 2, 3, 4, 5].includes(user.role)) return <Empty title="Operator access is required" />;
  return (
    <>
      <PageTitle title="Application links" />
      {meta.isError && <ErrorState error={meta.error} retry={() => void meta.refetch()} />}
      {error !== undefined && <ErrorState error={error} />}
      {!online && <p>Reconnect to generate or open application links.</p>}
      <div className="application-link-grid">
        <section className="surface">
          <h2>Staff installer</h2>
          <p>Scan the expiring QR or download the approved installer.</p>
          {!meta.data?.staffAvailable ? (
            <p>The staff installer is not available for this account.</p>
          ) : (
            <>
              <button
                className="button primary"
                disabled={!online || busy !== null}
                aria-busy={busy === 'staff'}
                onClick={() => void generate('staff')}
              >
                {staffQr ? 'Refresh staff QR' : 'Generate staff QR'}
              </button>
              {staffQr && (
                <div className="application-link-qr">
                  <img src={staffQr.qrDataUrl} alt="Staff installer QR code" />
                  <p role="status" className="application-qr-expiry" data-urgency={urgency}>
                    Expires in {Math.ceil(remaining / 1000)} seconds
                  </p>
                  <button
                    className="button secondary"
                    disabled={!online || busy !== null}
                    aria-busy={busy === 'download'}
                    onClick={() => void downloadStaff()}
                  >
                    Download staff installer
                  </button>
                </div>
              )}
            </>
          )}
        </section>
        <section className="surface">
          <h2>Customer application QR</h2>
          <p>Share the application link for your checked-in store.</p>
          {!meta.data?.customerAvailable ? (
            <p>Customer application links are not configured.</p>
          ) : !meta.data.checkedInStore ? (
            <p>Check in to a store before generating its application QR.</p>
          ) : (
            <>
              <button
                className="button primary"
                disabled={!online || busy !== null}
                aria-busy={busy === 'customer'}
                onClick={() => void generate('customer')}
              >
                Generate customer QR
              </button>
              {customerQr && (
                <div className="application-link-qr">
                  <img src={customerQr.qrDataUrl} alt="Customer application QR code" />
                  <p>{customerQr.storeName}</p>
                  <button className="button secondary" onClick={saveCustomerQr}>
                    Download customer QR
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}
