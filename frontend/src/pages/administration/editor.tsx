import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useOnline } from '../../hooks/use-pos';

export interface AdministrationField {
  name: string;
  label: string;
  kind?: 'text' | 'email' | 'tel' | 'number' | 'password' | 'textarea' | 'select' | 'time';
  required?: boolean;
  maxLength?: number;
  options?: { value: string; label: string }[];
  optionsAction?: { label: string; disabled: boolean; run: () => void };
  updateAction?: {
    label: string;
    run: (
      values: Readonly<Record<string, string>>,
      signal: AbortSignal,
    ) => Promise<Record<string, string>>;
  };
  when?: { field: string; value: string };
  whenAll?: { field: string; value: string }[];
}
export function AdministrationEditor({
  title,
  fields,
  initialValues,
  onSave,
  onClose,
  description,
  submitLabel = 'Save changes',
}: {
  title: string;
  fields: AdministrationField[];
  initialValues: Record<string, string>;
  onSave: (values: Record<string, string>) => Promise<void>;
  onClose: () => void;
  description?: string;
  submitLabel?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    action = useRef<AbortController | null>(null),
    [values, setValues] = useState(initialValues),
    [busy, setBusy] = useState(false),
    [actionBusy, setActionBusy] = useState<string | null>(null),
    [error, setError] = useState('');
  const online = useOnline();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      action.current?.abort();
      element?.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="administration-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="administration-dialog-heading">
        <div>
          <div className="eyebrow">STORE ADMINISTRATION</div>
          <h2>{title}</h2>
        </div>
        <button className="icon-button" aria-label="Close editor" disabled={busy} onClick={onClose}>
          <X size={19} />
        </button>
      </div>
      {description && <p className="administration-notice">{description}</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || actionBusy || !online) return;
          setBusy(true);
          setError('');
          void onSave(values)
            .then(onClose)
            .catch((failure: unknown) =>
              setError(
                failure instanceof Error ? failure.message : 'The change could not be saved.',
              ),
            )
            .finally(() => setBusy(false));
        }}
      >
        <fieldset className="administration-access-fieldset" disabled={busy || actionBusy !== null}>
          <div className="administration-fields">
            {fields
              .filter(
                (field) =>
                  (!field.when || values[field.when.field] === field.when.value) &&
                  (!field.whenAll ||
                    field.whenAll.every(
                      (condition) => values[condition.field] === condition.value,
                    )),
              )
              .map((field) => (
                <label
                  key={field.name}
                  className={field.kind === 'textarea' ? 'administration-wide' : ''}
                >
                  {field.label}
                  {field.kind === 'select' ? (
                    <select
                      aria-label={field.label}
                      required={field.required}
                      value={values[field.name] || ''}
                      onChange={(event) =>
                        setValues({ ...values, [field.name]: event.target.value })
                      }
                    >
                      {field.options?.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : field.kind === 'textarea' ? (
                    <textarea
                      aria-label={field.label}
                      required={field.required}
                      maxLength={field.maxLength}
                      value={values[field.name] || ''}
                      onChange={(event) =>
                        setValues({ ...values, [field.name]: event.target.value })
                      }
                    />
                  ) : (
                    <input
                      aria-label={field.label}
                      type={field.kind || 'text'}
                      step={field.kind === 'time' ? 1 : undefined}
                      required={field.required}
                      maxLength={field.maxLength}
                      autoComplete={field.kind === 'password' ? 'new-password' : 'off'}
                      value={values[field.name] || ''}
                      onChange={(event) =>
                        setValues({ ...values, [field.name]: event.target.value })
                      }
                    />
                  )}
                  {field.optionsAction && (
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy || field.optionsAction.disabled}
                      onClick={field.optionsAction.run}
                    >
                      {field.optionsAction.label}
                    </button>
                  )}
                  {field.updateAction && (
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy || actionBusy !== null || !online}
                      onClick={() => {
                        action.current?.abort();
                        const controller = new AbortController();
                        action.current = controller;
                        setActionBusy(field.name);
                        setError('');
                        void field
                          .updateAction!.run(values, controller.signal)
                          .then((patch) => {
                            if (!controller.signal.aborted)
                              setValues((current) => ({ ...current, ...patch }));
                          })
                          .catch((failure: unknown) => {
                            if (!controller.signal.aborted)
                              setError(
                                failure instanceof Error
                                  ? failure.message
                                  : 'This field could not be updated.',
                              );
                          })
                          .finally(() => {
                            if (!controller.signal.aborted) {
                              setActionBusy(null);
                              action.current = null;
                            }
                          });
                      }}
                    >
                      {actionBusy === field.name ? 'Looking up…' : field.updateAction.label}
                    </button>
                  )}
                </label>
              ))}
          </div>
        </fieldset>
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <div className="administration-dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy || actionBusy !== null || !online}>
            {busy ? 'Saving…' : submitLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
