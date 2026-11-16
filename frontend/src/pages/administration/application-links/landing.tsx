import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ErrorState } from '../../../components/common';
import {
  applicationDownloadSession,
  applicationFragment,
  customerApplicationSession,
  downloadApplicationBlob,
} from './api';
import '../styles.css';

export function ApplicationLinkLandingPage({ kind }: { kind: 'staff' | 'customer' }) {
  const location = useLocation();
  return (
    <ApplicationLandingFlow
      key={kind + ':' + location.search + ':' + location.hash}
      kind={kind}
      initialToken={location.search ? null : applicationFragment(location.hash)}
    />
  );
}
function ApplicationLandingFlow({
  kind,
  initialToken,
}: {
  kind: 'staff' | 'customer';
  initialToken: string | null;
}) {
  const [token] = useState(initialToken),
    [phase, setPhase] = useState<'ready' | 'working' | 'completed'>('ready'),
    [error, setError] = useState<unknown>(),
    lifetime = useRef(new AbortController()),
    action = useRef(
      token
        ? kind === 'staff'
          ? applicationDownloadSession(token)
          : customerApplicationSession(token)
        : null,
    );
  useEffect(() => {
    if (lifetime.current.signal.aborted) lifetime.current = new AbortController();
    const scope = lifetime.current;
    const state: unknown = window.history.state;
    window.history.replaceState(state, '', window.location.pathname);
    return () => scope.abort();
  }, []);
  async function open() {
    if (!action.current || phase === 'working') return;
    setPhase('working');
    setError(undefined);
    try {
      const result = await action.current(lifetime.current.signal);
      lifetime.current.signal.throwIfAborted();
      if (result instanceof Blob) {
        downloadApplicationBlob(result, 'mpos.apk');
        setPhase('completed');
      } else {
        setPhase('completed');
        window.location.assign(result);
      }
    } catch (failure) {
      if (!lifetime.current.signal.aborted) {
        setError(failure);
        setPhase('ready');
      }
    }
  }
  return (
    <main className="application-link-landing">
      <section className="surface">
        <h1>{kind === 'staff' ? 'Staff application download' : 'Open the customer application'}</h1>
        {!token ? (
          <p>This link is invalid. Request a new QR code from the store.</p>
        ) : (
          <>
            <p>
              {kind === 'staff'
                ? 'Download the approved staff installer.'
                : 'Continue to the store’s application link.'}
            </p>
            <button
              className="button primary"
              disabled={phase === 'working'}
              onClick={() => void open()}
            >
              {phase === 'working'
                ? 'Preparing…'
                : kind === 'staff'
                  ? phase === 'completed'
                    ? 'Download again'
                    : 'Download staff installer'
                  : 'Open customer app'}
            </button>
            {phase === 'completed' && (
              <p role="status">
                {kind === 'staff'
                  ? 'The download has started.'
                  : 'Your application link is ready. If the app did not open, try again.'}
              </p>
            )}
            {error !== undefined && <ErrorState error={error} />}
          </>
        )}
      </section>
    </main>
  );
}
