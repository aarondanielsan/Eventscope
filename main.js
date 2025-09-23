const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('node:path');

let mainWindow;
let authWindow = null;
let authSession = null;
let authToken = null;
let authCookieHeader = null;
let authPromise = null;

const LIGHTHOUSE_LOGIN_URL = 'https://lighthouse2.psav.com';
const LIGHTHOUSE_API_URL = 'https://api-cus.psav.com/lighthouse-api/production/api/flowsheets/flowsheet/GetActions';

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'EventScope.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function captureCookiesFromSession(targetSession) {
  if (!targetSession) return '';
  try {
    const cookiesApi = await targetSession.cookies.get({ url: 'https://api-cus.psav.com' }).catch(() => []);
    const cookiesLh = await targetSession.cookies.get({ url: 'https://lighthouse2.psav.com' }).catch(() => []);
    const cookies = [...cookiesApi, ...cookiesLh];
    if (cookies.length) {
      const header = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
      authCookieHeader = header;
      return header;
    }
  } catch (error) {
    console.warn('Unable to read Lighthouse cookies', error);
  }
  return '';
}

function clearAuthentication() {
  console.log('[Lighthouse] Clearing cached authentication');
  authToken = null;
  authCookieHeader = null;
  if (authSession) {
    authSession.clearStorageData({ storages: ['cookies'] }).catch(() => undefined);
  }
}

async function ensureAuthenticated(force = false) {
  if (force) {
    clearAuthentication();
  }
  if (authToken || authCookieHeader) {
    console.log('[Lighthouse] Using cached authentication');
    return;
  }
  if (authPromise) {
    return authPromise;
  }

  authPromise = new Promise((resolve, reject) => {
    const partition = 'persist:lighthouse-auth';
    authSession = session.fromPartition(partition, { cache: true });
    const filter = { urls: ['https://api-cus.psav.com/*'] };

    const cleanup = () => {
      if (authSession) {
        authSession.webRequest.onBeforeSendHeaders(null);
        authSession.webRequest.onCompleted(null);
      }
      if (authWindow && !authWindow.isDestroyed()) {
        authWindow.close();
      }
      authWindow = null;
      const pending = authPromise;
      authPromise = null;
      return pending;
    };

    const maybeResolve = async () => {
      if (authToken || authCookieHeader) {
        cleanup();
        resolve();
      }
    };

    authSession.webRequest.onBeforeSendHeaders(filter, async (details, callback) => {
      const header = details.requestHeaders?.Authorization || details.requestHeaders?.authorization;
      if (header) {
        authToken = header;
        console.log('[Lighthouse] Token captured from request headers');
      }
      callback({ requestHeaders: details.requestHeaders });
      await captureCookiesFromSession(authSession);
      await maybeResolve();
    });

    authSession.webRequest.onCompleted(filter, async () => {
      if (authSession) {
        const existing = authCookieHeader;
        await captureCookiesFromSession(authSession);
        if (!existing && authCookieHeader) {
          console.log('[Lighthouse] Session cookies captured');
        }
      }
      await maybeResolve();
    });

    console.log('[Lighthouse] Login triggered');
    authWindow = new BrowserWindow({
      width: 1100,
      height: 800,
      show: false,
      parent: mainWindow ?? undefined,
      modal: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition,
      },
    });

    authWindow.once('ready-to-show', () => {
      if (authWindow) authWindow.show();
    });

    authWindow.on('closed', () => {
      const pending = cleanup();
      if (!(authToken || authCookieHeader)) {
        reject(new Error('Lighthouse login was closed before authentication.'));
      }
      return pending;
    });

    authWindow.loadURL(LIGHTHOUSE_LOGIN_URL).catch(error => {
      cleanup();
      reject(error);
    });
  });

  return authPromise;
}

function buildAsOf(dateInput) {
  if (!dateInput) {
    return new Date().toISOString();
  }
  if (typeof dateInput === 'string' && dateInput.includes('T')) {
    const parsed = new Date(dateInput);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  const base = new Date(dateInput);
  if (!Number.isNaN(base.getTime())) {
    return new Date(Date.UTC(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0, 0)).toISOString();
  }
  return new Date().toISOString();
}

async function fetchLighthouseActions(dateInput, attempt = 0) {
  await ensureAuthenticated(attempt > 0);

  const asOf = buildAsOf(dateInput);
  const url = `${LIGHTHOUSE_API_URL}?asOf=${encodeURIComponent(asOf)}`;
  const headers = {
    Accept: 'application/json',
  };
  if (authToken) {
    headers.Authorization = authToken;
    console.log('[Lighthouse] Using Authorization header for Lighthouse fetch');
  } else {
    let cookieHeader = authCookieHeader;
    if (!cookieHeader) {
      try {
        const cookiesApi = await session.defaultSession.cookies.get({ url: 'https://api-cus.psav.com' }).catch(() => []);
        const cookiesLh = await session.defaultSession.cookies.get({ url: 'https://lighthouse2.psav.com' }).catch(() => []);
        const cookies = [...cookiesApi, ...cookiesLh];
        if (cookies.length) {
          cookieHeader = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
          console.log('[Lighthouse] Default session cookies collected for Lighthouse fetch');
        }
      } catch (error) {
        console.warn('[Lighthouse] Unable to read default session cookies', error);
      }
    }
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
      authCookieHeader = cookieHeader;
      console.log('[Lighthouse] Using Cookie header for Lighthouse fetch');
    } else {
      console.log('[Lighthouse] Proceeding without Authorization or Cookie headers');
    }
  }

  console.log('[Lighthouse] GetActions URL:', url);
  console.log('[Lighthouse] Auth bearer?', Boolean(headers.Authorization));
  console.log('[Lighthouse] Cookie header length:', headers.Cookie ? headers.Cookie.length : 0);
  console.log('[Lighthouse] Fetching actions for', asOf);
  const response = await fetch(url, { headers });
  if (response.status === 401 || response.status === 403) {
    if (attempt < 1) {
      clearAuthentication();
      await ensureAuthenticated(true);
      return fetchLighthouseActions(dateInput, attempt + 1);
    }
    throw new Error(`Lighthouse authentication failed (${response.status})`);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new Error(`Lighthouse request failed (${response.status}): ${bodyText}`);
  }

  const json = await response.json();
  console.log('[Lighthouse] Returning payload for', asOf);
  return json;
}

ipcMain.handle('lighthouse:getactions', async (_event, payload) => {
  const dateInput = payload?.asOf ?? payload?.date;
  console.log('[IPC] lighthouse:getactions received', dateInput);
  if (!dateInput) {
    throw new Error('A date string is required for Lighthouse sync.');
  }
  try {
    const data = await fetchLighthouseActions(dateInput);
    return data;
  } catch (error) {
    console.error('Failed to fetch Lighthouse data', error);
    throw error;
  }
});

app.whenReady().then(() => {
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
