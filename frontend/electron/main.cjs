const { app, BrowserWindow, session, dialog, shell } = require('electron');

// One web application and persistent Chromium profile provide the same offline
// shell/session on desktop. Production serves frontend + /api on one HTTPS origin.
function configuredUrl() {
  const value = process.env.POS_DESKTOP_URL;
  if (!value) throw new Error('Set POS_DESKTOP_URL to your deployed POS HTTPS URL.');
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (
    url.protocol !== 'https:' &&
    !(process.env.NODE_ENV === 'development' && url.protocol === 'http:' && local)
  )
    throw new Error('The desktop workspace must use HTTPS.');
  if (url.username || url.password)
    throw new Error('Do not embed credentials in the workspace URL.');
  return url;
}
function exactOrigins(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const origin = new URL(item);
      if (
        origin.protocol !== 'https:' ||
        origin.username ||
        origin.password ||
        origin.pathname !== '/' ||
        origin.search ||
        origin.hash
      )
        throw new Error('Trusted destinations require exact HTTPS origins.');
      return origin.origin;
    });
}
if (process.env.NODE_ENV === 'development' && process.env.POS_DESKTOP_PROFILE_DIR)
  app.setPath('userData', require('node:path').resolve(process.env.POS_DESKTOP_PROFILE_DIR));
app.enableSandbox();
if (process.platform === 'win32') app.setAppUserModelId('com.thesouledstore.pos');
if (!app.requestSingleInstanceLock()) app.quit();
else
  app
    .whenReady()
    .then(() => {
      let url;
      try {
        url = configuredUrl();
      } catch (error) {
        dialog.showErrorBox('Workspace configuration', error.message);
        app.quit();
        return;
      }
      const oauthOrigins = exactOrigins(
        [process.env.POS_SSO_ORIGINS || '', process.env.POS_OAUTH_ORIGINS || ''].join(','),
      );
      const allowed = new Set([url.origin, ...oauthOrigins]);
      const applicationOrigins = new Set(exactOrigins(process.env.POS_APP_LINK_ORIGINS || ''));
      const customerWebsiteOrigins = exactOrigins(process.env.POS_CUSTOMER_WEBSITE_ORIGIN || '');
      if (customerWebsiteOrigins.length > 1)
        throw new Error('Customer website sign-in requires one exact HTTPS origin.');
      const customerWebsiteOrigin = customerWebsiteOrigins[0];
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
      function openDesktopSso(destination) {
        try {
          const source = new URL(window.webContents.getURL());
          const target = new URL(destination);
          if (
            source.origin !== url.origin ||
            target.origin !== url.origin ||
            target.pathname !== '/api/v1/auth/sso/login' ||
            target.href.length > 2048 ||
            target.username ||
            target.password ||
            target.hash ||
            [...target.searchParams.keys()].length !== 2 ||
            target.searchParams.getAll('desktop').length !== 1 ||
            target.searchParams.getAll('ticket').length !== 1 ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              target.searchParams.get('desktop') || '',
            ) ||
            !/^[A-Za-z0-9_-]{43}$/.test(target.searchParams.get('ticket') || '')
          )
            return false;
          void shell.openExternal(target.href, { activate: true, logUsage: false }).catch(() => {
            dialog.showErrorBox(
              'Google sign-in',
              'The sign-in browser could not be opened. Try again.',
            );
          });
          return true;
        } catch {
          return false;
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
        if (!openDesktopSso(destination) && !openCustomerWebsite(destination))
          openApplicationLink(destination);
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
          if (
            target.origin === 'https://accounts.google.com' ||
            (target.origin === url.origin && target.pathname === '/api/v1/auth/sso/login')
          ) {
            event.preventDefault();
            if (external) openDesktopSso(destination);
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
