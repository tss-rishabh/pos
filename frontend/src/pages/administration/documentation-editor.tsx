import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, UploadCloud, Check, RotateCcw } from 'lucide-react';
import { request } from '../../api/client';
import type { Principal } from '../../api/types';
import { ErrorState, Loading, RequestReference, useProblem } from '../../components/common';
import {
  guideSchema,
  mediaCapabilitiesSchema,
  uploadGuideFile,
  type AttachmentKind,
  type Guide,
  type GuideFile,
} from './documentation-api';

interface PendingFile extends GuideFile {
  status: 'queued' | 'uploading' | 'ready' | 'failed';
  error?: string;
  cause?: unknown;
}
const categories: { kind: AttachmentKind; label: string }[] = [
  { kind: 'cover-image', label: 'Cover image' },
  { kind: 'image', label: 'Images' },
  { kind: 'video', label: 'Videos' },
  { kind: 'document', label: 'Documents' },
];

export function DocumentationEditor({
  user,
  guide,
  onClose,
  onSaved,
}: {
  user: Principal;
  guide: Guide | null;
  onClose: (saved?: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    controller = useRef(new AbortController()),
    closed = useRef(false),
    operationId = useRef(crypto.randomUUID());
  const [title, setTitle] = useState(guide?.title || ''),
    [summary, setSummary] = useState(guide?.summary || ''),
    [description, setDescription] = useState(guide?.description || ''),
    [keywords, setKeywords] = useState(guide?.keywords || ''),
    [priority, setPriority] = useState(String(guide?.sortOrder || 0));
  const [retained, setRetained] = useState(new Set(guide?.assets.map((asset) => asset.id) || [])),
    [files, setFiles] = useState<PendingFile[]>([]),
    [uploading, setUploading] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError, errorCause, reportError] = useProblem();
  const currentFiles = useRef<PendingFile[]>([]);
  currentFiles.current = files;
  const capabilities = useQuery({
    queryKey: [user.id, 'administration', 'guide-media-capabilities'],
    queryFn: ({ signal }) =>
      request(
        '/api/v1/admin/documentation/media-capabilities',
        { operatorId: user.id, signal },
        mediaCapabilitiesSchema,
      ),
  });
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      closed.current = true;
      controller.current.abort();
      element?.close();
    };
  }, []);
  const updateFile = (id: string, changes: Partial<PendingFile>) => {
    if (!closed.current)
      setFiles((previous) =>
        previous.map((file) => (file.id === id ? { ...file, ...changes } : file)),
      );
  };
  async function upload(file: PendingFile) {
    updateFile(file.id, { status: 'uploading', error: undefined });
    try {
      await uploadGuideFile(file, controller.current.signal, user.id);
      updateFile(file.id, { status: 'ready' });
    } catch (failure) {
      if (!closed.current)
        updateFile(file.id, {
          status: 'failed',
          error: failure instanceof Error ? failure.message : 'File upload could not finish.',
          cause: failure,
        });
    }
  }
  async function addFiles(kind: AttachmentKind, selected: FileList | null) {
    if (!selected || !capabilities.data?.enabled || uploading) return;
    setError('');
    const additions: PendingFile[] = [];
    for (const file of Array.from(selected)) {
      const type = capabilities.data.types.find(
        (value) =>
          value.kind === (kind === 'cover-image' ? 'image' : kind) &&
          (value.contentType === file.type ||
            ((!file.type || file.type === 'application/octet-stream') &&
              file.name.toLowerCase().endsWith('.' + value.extension))),
      );
      if (!type || file.size < 1 || file.size > type.maximumBytes) {
        setError(
          `Choose a supported ${kind === 'cover-image' ? 'image' : kind} within its size limit.`,
        );
        return;
      }
      additions.push({
        id: crypto.randomUUID(),
        kind,
        file,
        contentType: type.contentType,
        status: 'queued',
      });
    }
    if (files.length + additions.length > capabilities.data.maximumPendingFiles) {
      setError('Use fewer pending attachments before saving.');
      return;
    }
    if (
      kind === 'cover-image' &&
      (additions.length > 1 || files.some((file) => file.kind === kind))
    ) {
      setError('Choose one cover image.');
      return;
    }
    if (kind === 'cover-image')
      setRetained(
        (previous) =>
          new Set(
            [...previous].filter(
              (id) =>
                !guide?.assets.some((asset) => asset.id === id && asset.kind === 'cover-image'),
            ),
          ),
      );
    setFiles((previous) => [...previous, ...additions]);
    setUploading(true);
    try {
      for (const file of additions) {
        if (controller.current.signal.aborted) break;
        await upload(file);
      }
    } finally {
      if (!closed.current) setUploading(false);
    }
  }
  function cancelUpload(id: string) {
    void request(`/api/v1/admin/documentation/uploads/${id}`, {
      operatorId: user.id,
      method: 'DELETE',
    }).catch(() => undefined);
  }
  function close() {
    if (saving) return;
    closed.current = true;
    controller.current.abort();
    for (const file of currentFiles.current) cancelUpload(file.id);
    onClose();
  }
  const incomplete = files.some((file) => file.status !== 'ready');
  return (
    <dialog
      ref={dialog}
      className="administration-dialog administration-guide-editor"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="administration-dialog-heading">
        <div>
          <div className="eyebrow">STORE KNOWLEDGE</div>
          <h2>{guide ? 'Edit guide' : 'Create a guide'}</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close guide editor"
          disabled={saving}
          onClick={close}
        >
          <X size={18} />
        </button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (uploading || incomplete) return;
          setSaving(true);
          setError('');
          void request(
            guide ? `/api/v1/admin/documentation/${guide.id}` : '/api/v1/admin/documentation',
            {
              operatorId: user.id,
              method: guide ? 'PUT' : 'POST',
              body: JSON.stringify({
                operationId: operationId.current,
                expectedVersion: guide?.version ?? '',
                title,
                summary,
                description,
                keywords,
                sortOrder: Number(priority),
                retainAssetIds: [...retained],
                uploadIds: files.map((file) => file.id),
              }),
            },
            guideSchema.pick({ id: true, version: true }),
          )
            .then(async () => {
              closed.current = true;
              controller.current.abort();
              onClose(true);
              await onSaved();
            })
            .catch((failure: unknown) => {
              if (!closed.current) reportError(failure, 'Guide could not be saved.');
            })
            .finally(() => {
              if (!closed.current) setSaving(false);
            });
        }}
      >
        <fieldset disabled={saving} className="administration-guide-fieldset">
          <div className="administration-fields">
            <label>
              Title
              <input
                aria-label="Guide title"
                required
                maxLength={100}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label>
              Display priority
              <input
                aria-label="Guide display priority"
                type="number"
                min={-2147483648}
                max={2147483647}
                required
                value={priority}
                onChange={(event) => setPriority(event.target.value)}
              />
              <small>Higher values appear first.</small>
            </label>
            <label className="administration-wide">
              Short description
              <textarea
                aria-label="Guide short description"
                required
                maxLength={500}
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
              />
            </label>
            <label className="administration-wide">
              Description
              <textarea
                aria-label="Guide description"
                maxLength={1000}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <label className="administration-wide">
              Search keywords
              <input
                aria-label="Guide search keywords"
                maxLength={1000}
                value={keywords}
                onChange={(event) => setKeywords(event.target.value)}
              />
            </label>
          </div>
          <div className="administration-section-gap">
            <h3>Attachments</h3>
            {capabilities.isPending ? (
              <Loading />
            ) : capabilities.isError ? (
              <ErrorState error={capabilities.error} />
            ) : (
              <>
                <div className="administration-notice">
                  {capabilities.data.enabled
                    ? 'Images up to 10 MB, videos up to 100 MB, PDFs and office documents up to 25 MB.'
                    : 'New uploads are currently unavailable. You can still update the guide text.'}
                </div>
                {categories.map((category) => (
                  <section className="administration-upload-group" key={category.kind}>
                    <strong>{category.label}</strong>
                    {guide?.assets
                      .filter((asset) => asset.kind === category.kind)
                      .map((asset) => (
                        <label className="administration-existing-asset" key={asset.id}>
                          <input
                            type="checkbox"
                            checked={retained.has(asset.id)}
                            onChange={(event) =>
                              setRetained((previous) => {
                                const next = new Set(previous);
                                if (event.target.checked) next.add(asset.id);
                                else next.delete(asset.id);
                                return next;
                              })
                            }
                          />
                          Keep {asset.name}
                        </label>
                      ))}
                    <input
                      aria-label={`Upload ${category.label.toLowerCase()}`}
                      type="file"
                      disabled={!capabilities.data.enabled || uploading}
                      multiple={category.kind !== 'cover-image'}
                      accept={capabilities.data.types
                        .filter(
                          (type) =>
                            type.kind ===
                            (category.kind === 'cover-image' ? 'image' : category.kind),
                        )
                        .map((type) => '.' + type.extension)
                        .join(',')}
                      onChange={(event) => {
                        void addFiles(category.kind, event.target.files);
                        event.target.value = '';
                      }}
                    />
                    {files
                      .filter((file) => file.kind === category.kind)
                      .map((file) => (
                        <div key={file.id} className="administration-pending-upload">
                          <span>
                            {file.status === 'ready' ? (
                              <Check size={15} />
                            ) : (
                              <UploadCloud size={15} />
                            )}{' '}
                            {file.file.name} ·{' '}
                            {file.status === 'ready'
                              ? 'Ready'
                              : file.status === 'failed'
                                ? 'Upload failed'
                                : file.status === 'uploading'
                                  ? 'Uploading…'
                                  : 'Waiting'}
                          </span>
                          <div className="administration-actions">
                            {file.status === 'failed' && (
                              <button
                                type="button"
                                className="button secondary"
                                disabled={uploading}
                                onClick={() => {
                                  setUploading(true);
                                  void upload(file).finally(() => {
                                    if (!closed.current) setUploading(false);
                                  });
                                }}
                              >
                                <RotateCcw size={12} />
                                Retry
                              </button>
                            )}
                            <button
                              type="button"
                              className="button secondary"
                              disabled={uploading}
                              onClick={() => {
                                cancelUpload(file.id);
                                setFiles((previous) =>
                                  previous.filter((value) => value.id !== file.id),
                                );
                              }}
                            >
                              Remove
                            </button>
                          </div>
                          {file.error && <small role="alert">{file.error}</small>}
                          {file.error && <RequestReference error={file.cause} />}
                        </div>
                      ))}
                  </section>
                ))}
              </>
            )}
          </div>
        </fieldset>
        {error && (
          <div role="alert" className="inline-error">
            {error}
            <RequestReference error={errorCause} />
          </div>
        )}
        <div className="administration-dialog-actions">
          <button type="button" className="button secondary" disabled={saving} onClick={close}>
            Cancel
          </button>
          <button className="button primary" disabled={saving || uploading || incomplete}>
            {saving ? 'Saving…' : uploading ? 'Uploading attachments…' : 'Save guide'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
