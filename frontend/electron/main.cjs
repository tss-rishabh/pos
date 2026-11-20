// @ts-check
const { app, BrowserWindow, Menu, session, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { readWorkspaceConfiguration } = require('./workspace-config.cjs');
const { runtimeMode } = require('./runtime-mode.cjs');

function packageMetadata() {
  try {
    return require('../package.json');
  } catch {
    return null;
  }
}
// Packaged builds ignore NODE_ENV entirely (runtime-mode.cjs): DevTools, a loopback http origin
// and the profile override exist only for unpackaged development and the CI native-smoke flavour.
const mode = runtimeMode({
  isPackaged: app.isPackaged,
  env: process.env,
  packageMetadata: packageMetadata(),
});
// Packaged builds refuse Chromium debugging and mock-keychain switches: the fuses block Node
// inspection only, and a remote-debugging port would let any local process drive the renderer
// (and its offline billing bridge); a mock keychain would wrap the offline database key with a
// fixed, publicly known secret instead of the OS keystore. This runs before anything below
// can create files: app.setAppLogsPath creates its folder, and a refused launch must leave the
// profile untouched (tools/smoke-desktop-package.mjs, stage refused-switches).
const refusedSwitches = ['remote-debugging-port', 'remote-debugging-pipe', 'use-mock-keychain'];
if (app.isPackaged && refusedSwitches.some((name) => app.commandLine.hasSwitch(name))) {
  app.exit(1);
}
// One web application and persistent Chromium profile provide the same offline
// shell/session on desktop. Production serves frontend + /api on one HTTPS origin.
if (mode.profileDirectory) app.setPath('userData', mode.profileDirectory);
// The desktop log (rotating JSONL, offline/desktop-log.ts) lives in the OS log folder; a profile
// override (development and CI only) keeps its logs inside that profile.
if (mode.profileDirectory) app.setAppLogsPath(path.join(mode.profileDirectory, 'logs'));

/** Main-process bundle (offline billing + the desktop log); null when it cannot load.
 * @type {typeof import('./offline/index') | null | undefined} */
let offlineBundle;
function loadOfflineBundle() {
  if (offlineBundle !== undefined) return offlineBundle;
  try {
    // Built by electron/vite.config.ts and typed from its source entry (offline/index.ts); the
    // computed path keeps the generated bundle out of the shell's type-check.
    offlineBundle = require(path.join(__dirname, 'dist', 'offline-billing.cjs'));
  } catch (error) {
    offlineBundle = null;
    appendFallbackLog(error);
  }
  return offlineBundle;
}
const errorNameOf = (/** @type {unknown} */ error) =>
  error instanceof Error && /^[A-Za-z0-9_:.-]{1,64}$/.test(error.name) ? error.name : 'Error';
/**
 * Registered shell events only (offline/events.ts); identifiers and codes, never messages.
 * @param {Parameters<typeof import('./offline/index').desktopLog>[0]['eventId']} eventId
 * @param {{ errorCode: string, errorName?: string, reason?: string }} fields
 */
function shellLog(eventId, fields) {
  try {
    loadOfflineBundle()?.desktopLog({
      eventId,
      traceId: randomUUID(),
      outcome: 'failed',
      ...fields,
    });
  } catch {
    /* Logging never breaks the app. */
  }
}
/** The bundle (and with it the log sink) failed to load: record that one fixed line directly. */
/** @param {unknown} error */
function appendFallbackLog(error) {
  try {
    const directory = app.getPath('logs'),
      traceId = randomUUID();
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(
      path.join(directory, 'retail-pos.jsonl'),
      JSON.stringify({
        level: 50,
        time: Date.now(),
        msg: 'Offline billing could not start; the online workspace continues',
        process: 'main',
        module: 'desktop-shell',
        resource: 'offline-billing',
        eventId: 'desktop.offline-billing.start-failed',
        eventInstanceId: randomUUID(),
        traceId,
        requestId: traceId,
        userId: null,
        outcome: 'failed',
        errorCode: 'BUNDLE_UNAVAILABLE',
        errorName: errorNameOf(error),
      }) + '\n',
    );
  } catch {
    /* Logging never breaks the app. */
  }
}
// An unpackaged run is the stock Electron.app, so macOS would show its icon; use the app icon.
// Packaged builds carry build/icon.png in the bundle (.icns / .ico) and need nothing here.
if (!app.isPackaged && process.platform === 'darwin')
  void app
    .whenReady()
    .then(() => app.dock?.setIcon(path.join(__dirname, '..', 'build', 'icon.png')));
app.enableSandbox();
if (process.platform === 'win32') app.setAppUserModelId('com.thesouledstore.pos');
if (!app.requestSingleInstanceLock()) app.quit();
else
  app
    .whenReady()
    .then(() => {
      /** @type {URL} */
      let url;
      /** @type {ReturnType<typeof readWorkspaceConfiguration>} */
      let workspace;
      try {
        workspace = readWorkspaceConfiguration(process.env, undefined, mode.allowLoopbackHttp);
        url = new URL(workspace.url);
      } catch (error) {
        shellLog('desktop.app.start-failed', {
          errorCode: 'WORKSPACE_CONFIGURATION_INVALID',
          errorName: errorNameOf(error),
        });
        dialog.showErrorBox(
          'Workspace configuration',
          error instanceof Error
            ? error.message
            : 'The desktop workspace configuration is invalid.',
        );
        app.quit();
        return;
      }
      const allowed = new Set([url.origin, ...workspace.oauthOrigins]);
      const applicationOrigins = new Set(workspace.applicationOrigins);
      const customerWebsiteOrigin = workspace.customerWebsiteOrigin;
      const partition = 'persist:souled-pos';
      const profile = session.fromPartition(partition);
      profile.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      profile.setPermissionCheckHandler(() => false);
      installMenu();
      const window = new BrowserWindow({
        width: 1440,
        height: 960,
        minWidth: 1024,
        minHeight: 720,
        backgroundColor: '#f8f8f9' /* --athens-gray: native window paint before CSS loads */,
        title: 'Retail POS',
        show: false,
        // Windows/Linux: no menu bar, and Alt does not reveal it (see installMenu).
        autoHideMenuBar: false,
        webPreferences: {
          partition,
          preload: path.join(__dirname, 'preload.cjs'),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          devTools: mode.devTools,
        },
      });
      /** @param {string} destination */
      function openApplicationLink(destination) {
        try {
          const source = new URL(window.webContents.getURL());
          const target = new URL(destination);
          if (
            source.origin !== url.origin ||
            source.pathname !== '/application-links/customer' ||
            target.href.length > 2048 ||
            target.protocol !== 'https:' ||
            target.username ||
            target.password ||
            target.hash ||
            !applicationOrigins.has(target.origin)
          )
            return;
          const seen = new Set();
          for (const [key, value] of target.searchParams) {
            if (seen.has(key)) return;
            seen.add(key);
            if (key === 'store_id') {
              if (!/^[1-9]\d{0,9}$/.test(value) || BigInt(value) > 2147483647n) return;
            } else if (key === 'id') {
              if (!/^[A-Za-z][A-Za-z0-9_.-]{1,127}$/.test(value)) return;
            } else return;
          }
          void shell.openExternal(target.href, { activate: true, logUsage: false }).catch(() => {
            dialog.showErrorBox(
              'Application link',
              'The application link could not be opened. Try again.',
            );
          });
        } catch {
          // Never pass arbitrary schemes, credential URLs or raw failures to the OS or logs.
        }
      }
      /** @param {string} destination */
      function openCustomerWebsite(destination) {
        try {
          const source = new URL(window.webContents.getURL());
          const target = new URL(destination);
          if (
            source.origin !== url.origin ||
            source.pathname !== '/' ||
            !customerWebsiteOrigin ||
            target.origin !== customerWebsiteOrigin ||
            target.protocol !== 'https:' ||
            target.pathname !== '/pos/secure-login' ||
            target.href.length > 512 ||
            target.username ||
            target.password ||
            target.search ||
            !/^#[A-Za-z0-9_-]{43}$/.test(target.hash)
          )
            return false;
          void shell.openExternal(target.href, { activate: true, logUsage: false }).catch(() => {
            dialog.showErrorBox(
              'Customer website',
              'The customer website could not be opened. Try again before the link expires.',
            );
          });
          return true;
        } catch {
          return false;
        }
      }
      window.webContents.setWindowOpenHandler(({ url: destination }) => {
        if (!openCustomerWebsite(destination)) openApplicationLink(destination);
        return { action: 'deny' };
      });
      /**
       * @param {{ preventDefault(): void }} event
       * @param {string} destination
       */
      const restrictNavigation = (event, destination, external = false) => {
        try {
          const target = new URL(destination);
          if (customerWebsiteOrigin && target.origin === customerWebsiteOrigin) {
            event.preventDefault();
            if (external) openCustomerWebsite(destination);
            return;
          }
          if (!allowed.has(target.origin) || target.username || target.password) {
            event.preventDefault();
            if (external) openApplicationLink(destination);
          }
        } catch {
          event.preventDefault();
        }
      };
      window.webContents.on('will-navigate', (event, destination) =>
        restrictNavigation(event, destination, true),
      );
      window.webContents.on('will-redirect', (event, destination) =>
        restrictNavigation(event, destination),
      );
      window.webContents.on('will-attach-webview', (event) => event.preventDefault());
      if (process.platform !== 'darwin') window.setMenuBarVisibility(false);
      window.once('ready-to-show', () => window.show());
      window.webContents.on('render-process-gone', (_event, details) =>
        shellLog('desktop.renderer.gone', { errorCode: 'RENDERER_GONE', reason: details.reason }),
      );
      // Desktop offline billing (encrypted SQLite, main process only). A
      // failure here never blocks the online workspace.
      try {
        const bundle = loadOfflineBundle();
        if (bundle)
          void bundle
            .startOfflineBilling({ window, workspaceOrigin: url.origin, profile })
            .catch((error) =>
              shellLog('desktop.offline-billing.start-failed', {
                errorCode: 'OFFLINE_BILLING_START_FAILED',
                errorName: errorNameOf(error),
              }),
            );
      } catch (error) {
        // The online workspace continues without offline billing.
        shellLog('desktop.offline-billing.start-failed', {
          errorCode: 'OFFLINE_BILLING_START_FAILED',
          errorName: errorNameOf(error),
        });
      }
      window.loadURL(url.href).catch((error) => {
        shellLog('desktop.workspace.load-failed', {
          errorCode: 'WORKSPACE_LOAD_FAILED',
          errorName: errorNameOf(error),
        });
        dialog.showErrorBox(
          'Workspace unavailable',
          'Connect once to prepare this device for offline use. Your saved carts remain on this device.',
        );
        app.quit();
      });
      app.on('second-instance', () => {
        if (window.isMinimized()) window.restore();
        window.focus();
      });
    })
    .catch((error) => {
      shellLog('desktop.app.start-failed', {
        errorCode: 'APP_START_FAILED',
        errorName: errorNameOf(error),
      });
      dialog.showErrorBox('Workspace unavailable', 'Check the desktop workspace configuration.');
      app.quit();
    });
app.on('window-all-closed', () => app.quit());

/**
 * macOS keeps Electron's standard application menu in the system menu bar. Windows (and Linux)
 * show no menu bar in the POS window: the menu below is never visible, but its roles keep the
 * editing and zoom shortcuts working (Ctrl+Z/Y, Ctrl+X/C/V, Ctrl+A, Ctrl+0/+/=/-). Reload,
 * DevTools, close-window and external help links are deliberately absent.
 */
function installMenu() {
  if (process.platform === 'darwin') return;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { role: 'redo', accelerator: 'CommandOrControl+Shift+Z' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'delete' },
          { type: 'separator' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomIn', accelerator: 'CommandOrControl+=' },
          { role: 'zoomOut' },
        ],
      },
    ]),
  );
}
