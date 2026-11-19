/**
 * Desktop e2e ports. The defaults are the documented W17 ports; set E2E_DESKTOP_PORT_BASE to move
 * the whole desktop stack (web gate = base, preview = base+1, backend gate = base+2, backend =
 * base+3, control = base+4) so it can run beside the web e2e stack, which also uses 4173/4410.
 */
const base = Number(process.env.E2E_DESKTOP_PORT_BASE ?? '0');
if (!Number.isInteger(base) || base < 0 || base > 65530)
  throw new Error('E2E_DESKTOP_PORT_BASE must be a free TCP port number.');
export const desktopPorts = base
  ? {
      web: base,
      webPrivate: base + 1,
      backend: base + 2,
      backendPrivate: base + 3,
      control: base + 4,
    }
  : { web: 4173, webPrivate: 4174, backend: 4410, backendPrivate: 4411, control: 4499 };
/** The device's workspace origin: `localhost`, as on the W17 runs. */
export const desktopWorkspace = `http://localhost:${desktopPorts.web}`;
export const desktopControl = `http://127.0.0.1:${desktopPorts.control}`;
