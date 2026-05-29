// ==========================================================================
// FocusAura App - Google One-Click Sign-In & Drive Sync
// ==========================================================================

import { handleCloudDataSynced } from './app.js';

// ── Your Google OAuth Client ID (hardcoded for one-click login) ──
const CLIENT_ID = '186126440133-28iu1fkemvpsrfhu6j2j69ed0v37ra2f.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.appdata';
const DRIVE_FILE_NAME = 'timer-history.json';

let accessToken = null;
let currentUser = null;

// ==========================================================================
// Initialization — wait for GIS SDK to load, then render the Google button
// ==========================================================================
window.addEventListener('load', () => {
  waitForGIS();
});

function waitForGIS() {
  const check = setInterval(() => {
    if (typeof google !== 'undefined' && google.accounts) {
      clearInterval(check);
      initGoogleSignIn();
    }
  }, 100);
}

function initGoogleSignIn() {
  // 1. Initialize Google Identity Services for the Sign-In button
  google.accounts.id.initialize({
    client_id: CLIENT_ID,
    callback: handleCredentialResponse,  // called after user picks an account
    auto_select: true,                   // auto-sign-in if previously authorized
    cancel_on_tap_outside: true
  });

  // 2. Render the official Google "Sign in with Google" button
  const btnContainer = document.getElementById('g-signin-btn');
  if (btnContainer) {
    google.accounts.id.renderButton(btnContainer, {
      type: 'standard',
      theme: 'filled_black',
      size: 'large',
      text: 'signin_with',
      shape: 'pill',
      logo_alignment: 'left',
      width: 220
    });
  }

  // 3. Also show the One Tap prompt (the little popup in the corner)
  google.accounts.id.prompt();

  // Set up logout button
  const logoutBtn = document.getElementById('google-logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', handleLogout);
  }
}

// ==========================================================================
// Handle the sign-in credential response (JWT ID token)
// ==========================================================================
function handleCredentialResponse(response) {
  if (!response.credential) return;

  // Decode the JWT payload to get user info (name, email, picture)
  const payload = decodeJWT(response.credential);
  currentUser = {
    name: payload.given_name || payload.name || 'User',
    email: payload.email,
    picture: payload.picture
  };

  // Show user profile in the header
  displayUserProfile(currentUser);

  // Now request an access token for Google Drive (silent, no extra popup if already consented)
  requestDriveAccess();
}

// Simple JWT decoder (no library needed — the payload is base64)
function decodeJWT(token) {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
    );
    return JSON.parse(jsonPayload);
  } catch (e) {
    console.error('Failed to decode JWT:', e);
    return {};
  }
}

// ==========================================================================
// Request Google Drive access token (for syncing data)
// ==========================================================================
function requestDriveAccess() {
  const tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    prompt: '',  // empty = silent if already consented, otherwise shows consent
    callback: async (tokenResponse) => {
      if (tokenResponse.error) {
        console.warn('Drive access not granted:', tokenResponse.error);
        updateSyncStatus('offline', 'Local Only');
        return;
      }

      accessToken = tokenResponse.access_token;
      updateSyncStatus('syncing', 'Syncing...');

      // Trigger initial sync
      try {
        const localData = localStorage.getItem('focus_aura_data');
        let localHistory = {};
        if (localData) {
          try { localHistory = JSON.parse(localData).history || {}; } catch (e) {}
        }
        await syncDataWithGoogle(localHistory);
        updateSyncStatus('synced', 'Synced');
      } catch (err) {
        console.error('Initial sync failed:', err);
        updateSyncStatus('offline', 'Sync Failed');
      }
    }
  });

  tokenClient.requestAccessToken();
}

// ==========================================================================
// UI Helpers
// ==========================================================================
function displayUserProfile(user) {
  const signinBtn = document.getElementById('g-signin-btn');
  const profileCard = document.getElementById('user-profile');
  const avatar = document.getElementById('user-avatar');
  const nameEl = document.getElementById('user-name');

  if (signinBtn) signinBtn.classList.add('hidden');
  if (profileCard) profileCard.classList.remove('hidden');
  if (nameEl) nameEl.innerText = user.name;
  if (avatar) avatar.src = user.picture || 'https://www.gravatar.com/avatar/?d=mp';
}

function handleLogout() {
  google.accounts.id.disableAutoSelect();

  if (accessToken) {
    google.accounts.oauth2.revoke(accessToken, () => {
      console.log('Token revoked');
    });
  }

  accessToken = null;
  currentUser = null;

  // Reset UI
  const signinBtn = document.getElementById('g-signin-btn');
  const profileCard = document.getElementById('user-profile');
  if (signinBtn) signinBtn.classList.remove('hidden');
  if (profileCard) profileCard.classList.add('hidden');

  updateSyncStatus('offline', 'Local Only');
}

function updateSyncStatus(status, text) {
  const indicator = document.getElementById('sync-status');
  if (!indicator) return;
  indicator.className = `sync-indicator ${status}`;
  indicator.querySelector('.sync-text').innerText = text;
}

// ==========================================================================
// Google Drive REST API — Sync Operations
// ==========================================================================

export async function syncDataWithGoogle(localHistory) {
  if (!accessToken) return null;

  try {
    let fileId = await findHistoryFile();
    let cloudHistory = {};

    if (fileId) {
      cloudHistory = await downloadHistoryFile(fileId);
    }

    const mergedHistory = handleCloudDataSynced(cloudHistory);

    if (fileId) {
      await updateHistoryFile(fileId, mergedHistory || localHistory);
    } else {
      await createHistoryFile(mergedHistory || localHistory);
    }

    return mergedHistory;
  } catch (err) {
    console.error('Drive sync error:', err);
    throw err;
  }
}

async function findHistoryFile() {
  const query = encodeURIComponent(`name='${DRIVE_FILE_NAME}'`);
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${query}&fields=files(id,name)`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Drive list: ${res.statusText}`);
  const data = await res.json();
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

async function downloadHistoryFile(fileId) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error(`Drive download: ${res.statusText}`);
  return await res.json();
}

async function createHistoryFile(historyData) {
  const boundary = 'focus_aura_boundary';
  const metadata = { name: DRIVE_FILE_NAME, parents: ['appDataFolder'] };
  const body =
    `\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify(metadata) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
    JSON.stringify(historyData) +
    `\r\n--${boundary}--`;

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body
    }
  );
  if (!res.ok) throw new Error(`Drive create: ${res.statusText}`);
  return await res.json();
}

async function updateHistoryFile(fileId, historyData) {
  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(historyData)
    }
  );
  if (!res.ok) throw new Error(`Drive update: ${res.statusText}`);
  return await res.json();
}

// ==========================================================================
// Exports for app.js
// ==========================================================================
export function isUserLoggedIn() {
  return accessToken !== null;
}

// These are kept for backward compatibility with app.js imports
export function loadGoogleClientId() { return CLIENT_ID; }
export function saveGoogleClientId() {}
