import { CloudOff, RefreshCw } from 'lucide-react';
import { Empty, PageTitle, RequestReference, useProblem } from '../components/common';
import { Modal } from '../components/modal';
import type { Operation } from '../offline/database';
import { useState } from 'react';
import { db } from '../offline/database';
import { resolveConflict } from '../offline/sync';
import { request } from '../api/client';
import { draftSchema } from '../api/schemas';
import { z } from 'zod';
import type { Draft } from '../api/types';

export function SyncPage({
  operations,
  online,
  sync,
}: {
  operations: Operation[];
  online: boolean;
  sync: () => Promise<void>;
}) {
  const [review, setReview] = useState<{ operation: Operation; remote: Draft } | null>(null),
    [error, setError, errorCause, reportError] = useProblem();
  async function loadConflict(operation: Operation) {
    try {
      const result = await request(
        `/api/v1/stores/${operation.storeId}/cart-drafts`,
        {},
        z.object({ data: z.array(draftSchema) }),
      );
      const remote = result.data.find((d) => d.id === operation.draftId);
      if (!remote)
        throw new Error('The server sale was not found. Contact your store administrator.');
      setReview({ operation, remote });
      setError('');
    } catch (e) {
      reportError(e, 'Could not load the server sale.');
    }
  }
  async function choose(choice: 'local' | 'server') {
    if (!review) return;
    try {
      await resolveConflict(review.operation.ownerId, review.operation.id, review.remote, choice);
      setReview(null);
      await sync();
    } catch (e) {
      reportError(e, 'Could not resolve this sale.');
    }
  }
  return (
    <>
      <PageTitle title="Sync center">
        <button className="button secondary" disabled={!online} onClick={() => void sync()}>
          <RefreshCw size={16} />
          Sync now
        </button>
      </PageTitle>
      {!online && (
        <div className="sync-overview" role="status">
          <CloudOff size={20} aria-hidden="true" />
          <div>
            <h2>Working offline</h2>
            <p>Your carts remain on this device. They will sync after you reconnect.</p>
          </div>
        </div>
      )}
      {error && (
        <div role="alert" className="inline-error">
          {error}
          <RequestReference error={errorCause} />
        </div>
      )}
      <section className="surface">
        <div className="surface-title">
          <h2>Pending saves</h2>
          <span className="badge neutral">{operations.length}</span>
        </div>
        {operations.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Sale</th>
                  <th>Store</th>
                  <th>Status</th>
                  <th>Details</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {operations.map((op) => (
                  <tr key={op.id}>
                    <td className="mono">{op.draftId.slice(0, 8)}</td>
                    <td>{op.storeId}</td>
                    <td>
                      <span
                        className={`badge ${op.state === 'conflict' || op.state === 'rejected' ? 'red' : 'amber'}`}
                      >
                        {op.state}
                      </span>
                    </td>
                    <td>{op.message || 'Waiting to sync'}</td>
                    <td>
                      {op.state === 'conflict' && (
                        <button
                          className="button secondary"
                          disabled={!online}
                          onClick={() => void loadConflict(op)}
                        >
                          Review conflict
                        </button>
                      )}
                      {op.state === 'rejected' && (
                        <button
                          className="button secondary"
                          onClick={() => void db.operations.delete(op.id)}
                        >
                          Remove pending save
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="Everything is up to date">
            Your local carts are saved. There are no queued saves.
          </Empty>
        )}
      </section>
      {review && (
        <Modal
          title="This sale changed elsewhere."
          description="Choose which version to keep. Keeping your edits saves them as a new server version. Using the server copy replaces this device’s edits."
          closeLabel="Close"
          onClose={() => setReview(null)}
          footer={
            <>
              <button className="button secondary" onClick={() => setReview(null)}>
                Review later
              </button>
              <button className="button secondary" onClick={() => void choose('server')}>
                Use server copy
              </button>
              <button className="button primary" onClick={() => void choose('local')}>
                Keep my local edits
              </button>
            </>
          }
        >
          <div className="receipt-line">
            <div>
              <strong>Your pending save</strong>
              {review.operation.payload.draft.lines.map((line) => (
                <small key={line.productId}>
                  {line.name} × {line.quantity}
                </small>
              ))}
            </div>
            <div>
              <strong>Server version {review.remote.version}</strong>
              {review.remote.lines.map((line) => (
                <small key={line.productId}>
                  {line.name} × {line.quantity}
                </small>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
