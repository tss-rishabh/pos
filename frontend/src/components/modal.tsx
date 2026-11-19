import { useEffect, useId, useRef, type ReactNode, type Ref, type MouseEvent } from 'react';
import { X } from 'lucide-react';

/**
 * The app's one modal (W27): fixed widths, one padding scale, a header with the title and a close
 * button, a scrolling body and an optional sticky footer for the primary actions. Escape closes
 * the topmost dialog, focus moves into the dialog on open, Tab stays inside it, and focus returns
 * to the opener on close.
 */
export function Modal({
  title,
  description,
  onClose,
  closeLabel = 'Close',
  size = 'md',
  footer,
  children,
  dialogRef,
  className = '',
  onClickCapture,
  dismissible = true,
}: {
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  size?: 'sm' | 'md' | 'lg';
  footer?: ReactNode;
  children: ReactNode;
  dialogRef?: Ref<HTMLElement>;
  className?: string;
  onClickCapture?: (event: MouseEvent<HTMLElement>) => void;
  /** False while the dialog must stay open (no Escape and no close button). */
  dismissible?: boolean;
}) {
  const titleId = useId(),
    descriptionId = useId();
  const own = useRef<HTMLElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = own.current;
    if (dialog && !dialog.contains(document.activeElement)) {
      const first = dialog.querySelector<HTMLElement>('[autofocus]');
      (first ?? dialog).focus({ preventScroll: true });
    }
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  function setRef(element: HTMLElement | null) {
    own.current = element;
    if (typeof dialogRef === 'function') dialogRef(element);
    else if (dialogRef) (dialogRef as { current: HTMLElement | null }).current = element;
  }
  return (
    <div className="modal-backdrop">
      <section
        ref={setRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={`modal modal-${size} ${className}`.trim()}
        onClickCapture={onClickCapture}
        onKeyDown={(event) => {
          const dialog = own.current;
          if (!dialog || event.defaultPrevented) return;
          const target = event.target instanceof Element ? event.target : null;
          if (target?.closest('[role="dialog"],dialog') !== dialog) return;
          if (event.key === 'Escape' && dismissible) {
            event.preventDefault();
            close.current();
          } else if (event.key === 'Tab') {
            const focusable = [
              ...dialog.querySelectorAll<HTMLElement>(
                'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex]:not([tabindex="-1"])',
              ),
            ].filter((element) => element.getClientRects().length > 0);
            const first = focusable[0],
              last = focusable.at(-1);
            if (!first || !last) return;
            if (
              event.shiftKey &&
              (document.activeElement === first || document.activeElement === dialog)
            ) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <header className="modal-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && (
              <p id={descriptionId} className="modal-description">
                {description}
              </p>
            )}
          </div>
          {dismissible && (
            <button
              type="button"
              className="icon-button modal-close"
              aria-label={closeLabel}
              onClick={onClose}
            >
              <X size={18} />
            </button>
          )}
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </section>
    </div>
  );
}
