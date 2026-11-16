import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BookOpen, Download, Plus, X } from 'lucide-react';
import type { Principal } from '../../api/types';
import { request } from '../../api/client';
import { Empty, ErrorState, Loading, PageTitle } from '../../components/common';
import { mutateAdministration, useAdministrationCollection } from './api';
import { DocumentationEditor } from './documentation-editor';
import {
  downloadGuideAttachment,
  guideCursorSchema,
  guideSchema,
  type Guide,
  type GuideAttachment,
} from './documentation-api';

function GuideReader({
  guide,
  onClose,
  operatorId,
}: {
  guide: Guide;
  onClose: () => void;
  operatorId: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [downloading, setDownloading] = useState<string | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  async function download(attachment: GuideAttachment) {
    setDownloading(attachment.id);
    setError('');
    try {
      await downloadGuideAttachment(attachment, operatorId);
    } catch {
      setError('The attachment could not be downloaded. Try again.');
    } finally {
      setDownloading(null);
    }
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><style>body{font:14px/1.8 system-ui,sans-serif;margin:12px;color:#36442d;white-space:pre-wrap}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px}p{margin:0 0 12px}h2,h3{line-height:1.3}</style></head><body>${guide.descriptionHtml}</body></html>`;
  return (
    <dialog
      ref={dialog}
      className="administration-dialog administration-guide-reader"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="administration-dialog-heading">
        <div>
          <div className="eyebrow">STORE KNOWLEDGE</div>
          <h2>{guide.title}</h2>
        </div>
        <button className="icon-button" aria-label="Close guide" onClick={onClose}>
          <X size={19} />
        </button>
      </div>
      <p className="administration-guide-summary">{guide.summary}</p>
      <iframe
        title={`${guide.title} description`}
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={html}
        className="administration-guide-frame"
      />
      {(guide.mediaState === 'invalid-metadata' ||
        (guide.mediaState !== 'available' && guide.assets.length > 0)) && (
        <p className="administration-notice">
          Attachments are currently unavailable for this guide.
        </p>
      )}
      {guide.mediaState === 'available' && (
        <div className="administration-guide-assets">
          {guide.assets.map((asset) => (
            <section key={asset.id}>
              {(asset.kind === 'image' || asset.kind === 'cover-image') && (
                <img src={asset.url} alt={asset.name} loading="lazy" />
              )}
              {asset.kind === 'video' && (
                <video src={asset.url} controls preload="metadata" aria-label={asset.name} />
              )}
              <div className="administration-heading">
                <span>{asset.name}</span>
                <button
                  className="button secondary"
                  disabled={downloading !== null}
                  onClick={() => void download(asset)}
                >
                  <Download size={14} />
                  {downloading === asset.id ? 'Downloading…' : 'Download'}
                </button>
              </div>
            </section>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      <div className="administration-dialog-actions">
        <button className="button secondary" onClick={onClose}>
          Close guide
        </button>
      </div>
    </dialog>
  );
}

export function DocumentationPage({ user }: { user: Principal }) {
  const client = useQueryClient();
  const [search, setSearch] = useState(''),
    [status, setStatus] = useState('true'),
    [editing, setEditing] = useState<Guide | 'new' | null>(null),
    [reading, setReading] = useState<Guide | null>(null),
    [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState('');
  const collection = useAdministrationCollection(
    user.id,
    '/api/v1/documentation',
    guideSchema,
    search,
    status,
    guideCursorSchema,
  );
  const rows = collection.data?.pages.flatMap((page) => page.data) || [];
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: [user.id] });
  };
  async function edit(id: string) {
    try {
      setEditing(
        await request(`/api/v1/documentation/${id}`, { operatorId: user.id }, guideSchema),
      );
      setError(null);
    } catch (failure) {
      setError(failure);
    }
  }
  async function toggle(guide: Guide) {
    try {
      await mutateAdministration(
        `/api/v1/admin/documentation/${guide.id}/status`,
        'PATCH',
        {
          active: guide.active !== 1,
        },
        user.id,
      );
      setMessage(guide.active === 1 ? 'Guide archived.' : 'Guide activated.');
      setError(null);
      await refresh();
    } catch (failure) {
      setError(failure);
    }
  }
  return (
    <>
      <PageTitle eyebrow="STORE KNOWLEDGE" title="Documentation" />
      <div className="administration-heading">
        <h2>Guides and tutorials</h2>
        <div className="administration-filters">
          <input
            aria-label="Find documentation"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find a guide"
          />
          {user.role === 1 && (
            <>
              <select
                aria-label="Documentation status"
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                <option value="true">Active</option>
                <option value="false">Archived</option>
                <option value="all">All</option>
              </select>
              <button className="button primary" onClick={() => setEditing('new')}>
                <Plus size={16} />
                Create guide
              </button>
            </>
          )}
        </div>
      </div>
      {message && (
        <div role="status" className="administration-status">
          {message}
        </div>
      )}
      {error !== null && <ErrorState error={error} />}
      <section className="surface">
        {collection.isPending ? (
          <Loading />
        ) : collection.isError ? (
          <ErrorState error={collection.error} />
        ) : (
          <div className="administration-guides">
            {rows.map((guide) => (
              <article key={guide.id}>
                <div className="administration-heading">
                  <h3>{guide.title}</h3>
                  {user.role === 1 && (
                    <div className="administration-actions">
                      <button className="button secondary" onClick={() => void edit(guide.id)}>
                        Edit
                      </button>
                      <button className="button secondary" onClick={() => void toggle(guide)}>
                        {guide.active === 1 ? 'Archive' : 'Activate'}
                      </button>
                    </div>
                  )}
                </div>
                <p>{guide.summary}</p>
                <div className="administration-guide-footer">
                  <small>
                    Updated <time>{guide.updatedAt}</time> by {guide.uploaderName}
                  </small>
                  <button className="button secondary" onClick={() => setReading(guide)}>
                    <BookOpen size={14} />
                    Read guide
                  </button>
                </div>
              </article>
            ))}
            {!rows.length && <Empty title="No guides found" />}
          </div>
        )}
        {collection.hasNextPage && (
          <button
            className="button secondary load-more"
            onClick={() => void collection.fetchNextPage()}
          >
            Load more guides
          </button>
        )}
      </section>
      {reading && (
        <GuideReader
          key={reading.id}
          guide={reading}
          operatorId={user.id}
          onClose={() => setReading(null)}
        />
      )}
      {editing && (
        <DocumentationEditor
          key={editing === 'new' ? 'new' : `${editing.id}:${editing.version}`}
          user={user}
          guide={editing === 'new' ? null : editing}
          onClose={(saved) => {
            setEditing(null);
            if (!saved) void refresh();
          }}
          onSaved={async () => {
            setMessage(editing === 'new' ? 'Guide created.' : 'Guide updated.');
            await refresh();
          }}
        />
      )}
    </>
  );
}
