import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import type { Principal } from '../../api/types';
import { ApiError, request } from '../../api/client';
import { checkInSchema } from '../administration/api';
import './day-close-reminder.css';

const intervalSchema = z.number().int().min(60000).max(86400000).optional();
export const dayClosePromptSchema = z.discriminatedUnion('prompt', [
  z.object({
    prompt: z.literal(false),
    nagIntervalMs: intervalSchema,
    businessTimeZone: z.string().min(1).max(64).optional(),
  }),
  z.object({
    prompt: z.literal(true),
    closeDate: z.iso.date(),
    status: z.string().max(32),
    nagIntervalMs: intervalSchema,
    businessTimeZone: z.string().min(1).max(64).optional(),
  }),
]);
type Prompt = Extract<z.infer<typeof dayClosePromptSchema>, { prompt: true }>;
const accessDenied = (error: unknown) =>
  error instanceof ApiError && (error.status === 401 || error.status === 403);

function anotherDialog(current: HTMLDialogElement | null) {
  return Array.from(
    document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"]'),
  ).some(
    (element) =>
      element !== current &&
      !current?.contains(element) &&
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden',
  );
}

/** The server chooses eligibility/date/status; this component only spaces reminders. */
export function DayCloseReminder({
  user,
  storeId,
  enabled,
}: {
  user: Principal;
  storeId: string;
  enabled: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  const current = useQuery({
    queryKey: [user.id, 'administration', 'my-check-in'],
    enabled,
    queryFn: ({ signal }) =>
      request(
        '/api/v1/operators/me/check-in',
        { operatorId: user.id, signal },
        z.object({ data: checkInSchema.nullable() }),
      ),
    staleTime: 10000,
    retry: (count, error) => !accessDenied(error) && count < 1,
  });
  const checkIn = current.data?.data;
  const expiry = checkIn ? Date.parse(checkIn.expiresAt) : NaN;
  useEffect(() => {
    if (!Number.isFinite(expiry)) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Math.min(2147483647, expiry - Date.now() + 1)),
    );
    return () => clearTimeout(timer);
  }, [expiry]);
  if (
    !enabled ||
    !current.isSuccess ||
    current.isError ||
    !checkIn ||
    checkIn.storeId !== storeId ||
    expiry <= Math.max(now, Date.now())
  )
    return null;
  const authorityKey = JSON.stringify([
    user.id,
    user.role,
    user.userType,
    storeId,
    checkIn.counterId,
    checkIn.expiresAt,
  ]);
  return <ScopedReminder key={authorityKey} operatorId={user.id} storeId={storeId} />;
}

function ScopedReminder({ operatorId, storeId }: { operatorId: string; storeId: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const dismissCurrent = useRef<() => void>(() => undefined);
  const snoozeKey = `pos-day-close-reminder:${JSON.stringify([operatorId, storeId])}`;
  useEffect(() => {
    let disposed = false,
      inFlight = false,
      blocked = false,
      waitingForModal = false;
    let intervalMs = 600000;
    let configured = false;
    let displayed = false;
    let memoryLastShown = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const mountedDialog = dialog.current;
    const lastShown = () => {
      try {
        const stored = Number(localStorage.getItem(snoozeKey) || 0);
        if (Number.isFinite(stored) && stored >= 0 && stored <= Date.now())
          memoryLastShown = Math.max(memoryLastShown, stored);
      } catch {
        /* Keep spacing in memory when browser storage is unavailable. */
      }
      return memoryLastShown;
    };
    const stamp = () => {
      memoryLastShown = Date.now();
      try {
        localStorage.setItem(snoozeKey, String(memoryLastShown));
      } catch {
        /* Optional persistence. */
      }
    };
    const dismiss = () => {
      if (displayed) {
        dialog.current?.close();
        stamp();
        displayed = false;
      }
      setPrompt(null);
    };
    dismissCurrent.current = dismiss;
    const schedule = () => {
      clearTimeout(timer);
      if (disposed || blocked) return;
      const remaining = intervalMs - (Date.now() - lastShown());
      timer = setTimeout(
        () => {
          void check();
        },
        remaining > 0 ? remaining + 1 : intervalMs,
      );
    };
    const display = (result: Prompt) => {
      if (
        disposed ||
        blocked ||
        document.visibilityState !== 'visible' ||
        dialog.current?.open ||
        Date.now() - lastShown() < intervalMs
      )
        return;
      if (anotherDialog(dialog.current)) {
        waitingForModal = true;
        return;
      }
      const element = dialog.current;
      if (!element) return;
      flushSync(() => setPrompt(result));
      try {
        element.showModal();
      } catch {
        setPrompt(null);
        waitingForModal = true;
        return;
      }
      // Claim only after the dialog has actually opened, then buy a full interval
      // again on every dismissal (including navigation, Escape and teardown).
      displayed = true;
      stamp();
      waitingForModal = false;
      element.querySelector<HTMLButtonElement>('button')?.focus();
    };
    const check = async () => {
      if (
        disposed ||
        blocked ||
        inFlight ||
        dialog.current?.open ||
        document.visibilityState !== 'visible'
      ) {
        schedule();
        return;
      }
      if (configured && Date.now() - lastShown() < intervalMs) {
        schedule();
        return;
      }
      inFlight = true;
      try {
        const result = await request(
          `/api/v1/stores/${storeId}/day-close-prompt`,
          {
            operatorId,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
          },
          dayClosePromptSchema,
        );
        if (disposed) return;
        intervalMs = result.nagIntervalMs ?? 600000;
        configured = true;
        if (!result.prompt || document.visibilityState !== 'visible') return;
        // Re-read the shared snooze after the server reply and under the tab lock.
        // A competing visible window may have opened while this read was in flight.
        if (navigator.locks)
          await navigator.locks.request(`pos-day-close-reminder:${snoozeKey}`, () =>
            display(result),
          );
        else display(result);
      } catch (error: unknown) {
        if (accessDenied(error)) {
          blocked = true;
          dismiss();
        }
      } finally {
        inFlight = false;
        schedule();
      }
    };
    const visibility = () => {
      if (document.visibilityState === 'visible') void check();
    };
    const storage = (event: StorageEvent) => {
      if (event.key === snoozeKey || event.key === null) schedule();
    };
    let previousOther = anotherDialog(dialog.current);
    const observer = new MutationObserver(() => {
      if (disposed) return;
      const other = anotherDialog(dialog.current);
      if (other === previousOther) return;
      previousOther = other;
      if (other && dialog.current?.open) dismiss();
      if (!other && waitingForModal) {
        waitingForModal = false;
        void check();
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open', 'role', 'aria-modal', 'hidden', 'style', 'class'],
    });
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('storage', storage);
    void check();
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('storage', storage);
      if (displayed) {
        mountedDialog?.close();
        stamp();
        displayed = false;
      }
      dismissCurrent.current = () => undefined;
    };
  }, [operatorId, storeId, snoozeKey]);
  const dismiss = () => dismissCurrent.current();
  const stale = prompt?.status === 'STALE';
  return (
    <dialog
      ref={dialog}
      className="day-close-reminder"
      aria-labelledby="day-close-reminder-title"
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      onClose={() => {
        if (!dialog.current?.open) dismiss();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          dismiss();
      }}
    >
      <h2 id="day-close-reminder-title">
        {stale ? 'Day close needs redoing' : 'Day close pending'}
      </h2>
      {prompt && (
        <p>
          {stale
            ? `The close for ${prompt.closeDate} is no longer valid because the day’s figures changed. Please count again and file it.`
            : `The store close for ${prompt.closeDate} has not been filed yet.`}
        </p>
      )}
      <div className="day-close-reminder-actions">
        <button className="button secondary" onClick={dismiss}>
          Not now
        </button>
        {prompt && (
          <Link
            className="button primary"
            to={`/day-close?date=${encodeURIComponent(prompt.closeDate)}`}
            onClick={dismiss}
          >
            Close the day now
          </Link>
        )}
      </div>
    </dialog>
  );
}
