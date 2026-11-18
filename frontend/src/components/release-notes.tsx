import { useEffect, useId, useRef } from 'react';
import type { Principal } from '../api/types';
import './release-notes.css';

const roleChanges = [
  ['Merchant', 'OPM'],
  ['Staff', 'SM'],
  ['Cashier', 'Staff'],
] as const;

/** Informational source release notes; the New badge deliberately has no seen state. */
export function ReleaseNotes({ role }: { role: Principal['role'] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    return () => element?.close();
  }, []);
  function open() {
    const active = Array.from(
      document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"]'),
    ).some(
      (element) =>
        element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden',
    );
    if (!active) dialog.current?.showModal();
  }
  return (
    <>
      <button ref={trigger} type="button" className="release-notes-trigger" onClick={open}>
        What’s New <span>New</span>
      </button>
      <dialog
        ref={dialog}
        className="release-notes"
        aria-labelledby={titleId}
        onClose={() => trigger.current?.focus()}
      >
        <header>
          <h2 id={titleId}>What’s New</h2>
          <button
            type="button"
            className="button secondary"
            onClick={() => dialog.current?.close()}
          >
            Close
          </button>
        </header>
        <section>
          <h3>User role names updated</h3>
          <p>
            We’ve renamed a few user roles to match how teams work. Your access and permissions stay
            the same; only the labels have changed.
          </p>
          <table>
            <thead>
              <tr>
                <th scope="col">Previous name</th>
                <th scope="col">Current name</th>
              </tr>
            </thead>
            <tbody>
              {roleChanges.map(([previous, current]) => (
                <tr key={previous}>
                  <td>{previous}</td>
                  <td>{current}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>The new names appear in user management and your account role.</p>
        </section>
        {role === 1 && (
          <section>
            <h3>“Cashier Performance” is now “Staff Performance”</h3>
            <p>
              The report under Performance has a new name. It keeps the same data and columns.
              Salesperson Performance and Hyperlocal Reports keep their names.
            </p>
          </section>
        )}
        <footer>
          <span>
            Updated <time dateTime="2026-09-08">8 Sep 2026</time>
          </span>
          <button type="button" className="button primary" onClick={() => dialog.current?.close()}>
            Got it
          </button>
        </footer>
      </dialog>
    </>
  );
}
