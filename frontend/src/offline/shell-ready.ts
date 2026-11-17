/** New offline cash must not be advertised while its first application shell
 * or print assets are still unavailable. Existing saved money is never erased
 * or blocked from read-only recovery by this readiness check. */
export async function requireOfflineCashShell(
  signal: AbortSignal,
  assets: readonly string[] = [],
): Promise<void> {
  if (!import.meta.env.PROD) return;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  const unavailable = () =>
    new Error(
      'The offline workspace is still being prepared. Keep saved sales, reconnect, and finish any pending application update before enabling offline cash.',
    );
  async function bounded<T>(work: Promise<T>) {
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(unavailable());
          deadline.addEventListener('abort', abort, { once: true });
          if (deadline.aborted) abort();
        }),
      ]);
    } finally {
      if (abort) deadline.removeEventListener('abort', abort);
    }
  }
  try {
    deadline.throwIfAborted();
    if (!('serviceWorker' in navigator) || !('caches' in window)) throw unavailable();
    const registration = await bounded(navigator.serviceWorker.ready);
    if (
      !registration.active ||
      registration.installing ||
      registration.waiting ||
      new URL(registration.scope).origin !== window.location.origin ||
      new URL(registration.active.scriptURL).origin !== window.location.origin ||
      new URL(registration.active.scriptURL).pathname !== '/service-worker.js'
    )
      throw unavailable();
    if (!navigator.serviceWorker.controller) {
      let changed: (() => void) | undefined;
      try {
        await bounded(
          new Promise<void>((resolve) => {
            changed = () => {
              if (navigator.serviceWorker.controller) resolve();
            };
            navigator.serviceWorker.addEventListener('controllerchange', changed);
            changed();
          }),
        );
      } finally {
        if (changed) navigator.serviceWorker.removeEventListener('controllerchange', changed);
      }
    }
    if (!navigator.serviceWorker.controller || registration.installing || registration.waiting)
      throw unavailable();
    const required = new Set(['/index.html']);
    const linked = [
      ...document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>(
        'script[src],link[rel="stylesheet"][href]',
      ),
    ].map((element) => (element instanceof HTMLScriptElement ? element.src : element.href));
    for (const input of [...assets, ...linked]) {
      const url = new URL(input, window.location.href);
      if (url.origin !== window.location.origin) continue;
      if (url.pathname.startsWith('/assets/')) required.add(url.pathname);
    }
    let available = false;
    for (const name of await bounded(caches.keys())) {
      if (!/^souled-pos-shell-[a-f0-9]{12}$/.test(name)) continue;
      const cache = await bounded(caches.open(name));
      const found = await bounded(
        Promise.all([...required].map((url) => cache.match(url, { ignoreVary: true }))),
      );
      if (found.every((entry) => entry?.ok)) {
        available = true;
        break;
      }
    }
    deadline.throwIfAborted();
    if (!available) throw unavailable();
  } catch {
    signal.throwIfAborted();
    throw unavailable();
  }
}
