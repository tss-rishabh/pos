import { useEffect, useId, useRef, useState } from 'react';
import { RequestReference, useProblem } from '../../components/common';
import { Modal } from '../../components/modal';
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
  const formId = useId(),
    action = useRef<AbortController | null>(null),
    [values, setValues] = useState(initialValues),
    [busy, setBusy] = useState(false),
    [actionBusy, setActionBusy] = useState<string | null>(null),
    [error, setError, errorCause, reportError] = useProblem();
  const online = useOnline();
  useEffect(
    () => () => {
      action.current?.abort();
    },
    [],
  );
  return (
    <Modal
      title={title}
      description={description}
      closeLabel="Close editor"
      dismissible={!busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            className="button primary"
            disabled={busy || actionBusy !== null || !online}
            aria-busy={busy}
          >
            {busy ? 'Saving…' : submitLabel}
          </button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || actionBusy || !online) return;
          setBusy(true);
          setError('');
          void onSave(values)
            .then(onClose)
            .catch((failure: unknown) => reportError(failure, 'The change could not be saved.'))
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
                      aria-busy={actionBusy === field.name}
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
                              reportError(failure, 'This field could not be updated.');
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
            <RequestReference error={errorCause} />
          </div>
        )}
      </form>
    </Modal>
  );
}
