const { app, BrowserWindow, session, dialog, shell } = require('electron');
const path = require('node:path');
const { readWorkspaceConfiguration } = require('./workspace-config.cjs');

// One web application and persistent Chromium profile provide the same offline
// shell/session on desktop. Production serves frontend + /api on one HTTPS origin.
if (process.env.NODE_ENV === 'development' && process.env.POS_DESKTOP_PROFILE_DIR)
  app.setPath('userData', require('node:path').resolve(process.env.POS_DESKTOP_PROFILE_DIR));
// Packaged builds refuse Chromium debugging and mock-keychain switches: the fuses block Node
// inspection only, and a remote-debugging port would let any local process drive the renderer
// (and its offline billing bridge); a mock keychain would wrap the offline database key with a
// fixed, publicly known secret instead of the OS keystore.
const refusedSwitches = ['remote-debugging-port', 'remote-debugging-pipe', 'use-mock-keychain'];
if (app.isPackaged && refusedSwitches.some((name) => app.commandLine.hasSwitch(name))) {
  app.exit(1);
}
app.enableSandbox();
if (process.platform === 'win32') app.setAppUserModelId('com.thesouledstore.pos');
if (!app.requestSingleInstanceLock()) app.quit();
else
  app
    .whenReady()
    .then(() => {
      let url, workspace;
      try {
        workspace = readWorkspaceConfiguration();
        url = new URL(workspace.url);
      } catch (error) {
        dialog.showErrorBox('Workspace configuration', error.message);
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
      const window = new BrowserWindow({
        width: 1440,
        height: 960,
        minWidth: 1024,
        minHeight: 720,
        backgroundColor: '#f6f5f1',
        title: 'Souled POS',
        show: false,
        webPreferences: {
          partition,
          preload: path.join(__dirname, 'preload.cjs'),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          devTools: process.env.NODE_ENV === 'development',
        },
      });
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
      window.once('ready-to-show', () => window.show());
      // Desktop offline billing (encrypted SQLite, main process only). A
      // failure here never blocks the online workspace.
      try {
        void require('./dist/offline-billing.cjs')
          .startOfflineBilling({ window, workspaceOrigin: url.origin, profile })
          .catch(() => undefined);
      } catch {
        /* Offline billing bundle unavailable; the online workspace continues. */
      }
      window.loadURL(url.href).catch(() => {
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
    .catch(() => {
      dialog.showErrorBox('Workspace unavailable', 'Check the desktop workspace configuration.');
      app.quit();
    });
app.on('window-all-closed', () => app.quit());
