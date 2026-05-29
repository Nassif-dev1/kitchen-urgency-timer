// ==========================================================================
// FocusAura App - Google OAuth & Drive AppData Cloud Sync Module
// ==========================================================================

import { handleCloudDataSynced } from './app.js';

// Configuration
const CONFIG = {
  CLIENT_ID_KEY: 'focus_aura_google_client_id',
  LOGGED_IN_KEY: 'focus_aura_logged_in',
  DRIVE_FILE_NAME: 'timer-history.json',
  SCOPES: 'openid profile email https://www.googleapis.com/auth/drive.appdata'
};

let tokenClient = null;
let accessToken = null;
let gisLoaded = false;
let authCallback = null;

// On script load
window.addEventListener('load', () => {
  checkGisLoaded();
});

function checkGisLoaded() {
  const checkInterval = setInterval(() => {
    if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) {
      clearInterval(checkInterval);
      gisLoaded = true;
      initAuthModule();
    }
  }, 100);
}

function initAuthModule() {
  const savedClientId = loadGoogleClientId();
  
  if (savedClientId) {
    initializeTokenClient(savedClientId);
    
    // Auto-login if previously logged in
    const wasLoggedIn = localStorage.getItem(CONFIG.LOGGED_IN_KEY) === 'true';
    if (wasLoggedIn) {
      silentLogin();
    }
  } else {
    // Gracefully guide the user
    updateSyncStatus('offline', 'Local Only (No Client ID)');
  }
  
  setupAuthEventListeners();
}

// Initialize GIS Token Client
function initializeTokenClient(clientId) {
  try {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: CONFIG.SCOPES,
      prompt: 'consent', // Prompt consent on manual trigger
      callback: async (tokenResponse) => {
        if (tokenResponse.error) {
          console.error('OAuth error:', tokenResponse.error);
          updateSyncStatus('offline', 'Auth Failed');
          return;
        }
        
        accessToken = tokenResponse.access_token;
        localStorage.setItem(CONFIG.LOGGED_IN_KEY, 'true');
        
        updateSyncStatus('syncing', 'Authenticating...');
        
        // Fetch User Info & Sync data
        await loadUserProfile();
        
        if (authCallback) {
          await authCallback();
        }
      }
    });
  } catch (err) {
    console.error('Failed to initialize Google Auth Client:', err);
  }
}

// Silent Login (no consent screen if already authorized)
function silentLogin() {
  const clientId = loadGoogleClientId();
  if (!clientId || !gisLoaded) return;
  
  try {
    // Create token client for silent login (skip consent if already approved)
    const silentClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: CONFIG.SCOPES,
      prompt: '', // Silent authentication
      callback: async (tokenResponse) => {
        if (tokenResponse.error) {
          console.warn('Silent auth failed, falling back. Manual sign in required.', tokenResponse.error);
          localStorage.removeItem(CONFIG.LOGGED_IN_KEY);
          updateSyncStatus('offline', 'Signed Out');
          return;
        }
        
        accessToken = tokenResponse.access_token;
        localStorage.setItem(CONFIG.LOGGED_IN_KEY, 'true');
        
        updateSyncStatus('syncing', 'Syncing...');
        await loadUserProfile();
        
        // Trigger initial background sync
        if (authCallback) {
          await authCallback();
        }
      }
    });
    
    silentClient.requestAccessToken({ prompt: '' });
  } catch (err) {
    console.warn('Silent login error:', err);
  }
}

// Fetch user name and avatar via Userinfo endpoint
async function loadUserProfile() {
  if (!accessToken) return;
  
  try {
    const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });
    
    if (!response.ok) throw new Error('Failed to fetch userinfo');
    
    const profile = await response.json();
    displayUserProfile(profile);
  } catch (err) {
    console.error('Error getting profile details:', err);
  }
}

function displayUserProfile(profile) {
  const loginBtn = document.getElementById('google-login-btn');
  const userProfileCard = document.getElementById('user-profile');
  const userAvatar = document.getElementById('user-avatar');
  const userName = document.getElementById('user-name');
  
  if (!loginBtn || !userProfileCard) return;
  
  loginBtn.classList.add('hidden');
  userProfileCard.classList.remove('hidden');
  
  userName.innerText = profile.given_name || profile.name || 'User';
  userAvatar.src = profile.picture || 'https://www.gravatar.com/avatar/?d=mp';
}

function handleLogout() {
  if (accessToken) {
    google.accounts.oauth2.revokeToken(accessToken, () => {
      console.log('Access token revoked');
    });
  }
  
  accessToken = null;
  localStorage.removeItem(CONFIG.LOGGED_IN_KEY);
  
  // Update UI
  const loginBtn = document.getElementById('google-login-btn');
  const userProfileCard = document.getElementById('user-profile');
  if (loginBtn && userProfileCard) {
    loginBtn.classList.remove('hidden');
    userProfileCard.classList.add('hidden');
  }
  
  updateSyncStatus('offline', 'Local Only');
  alert('You have logged out from Google. Focus logs will save in this browser only.');
}

// ==========================================================================
// Google Drive API REST Sync Operations
// ==========================================================================

export async function syncDataWithGoogle(localHistory) {
  if (!accessToken) {
    console.log('Cannot sync: Not authenticated with Google.');
    return null;
  }
  
  try {
    // 1. Search for existing history file in appDataFolder
    let fileId = await findHistoryFile();
    let cloudHistory = {};
    
    if (fileId) {
      // 2. File exists: Download it
      cloudHistory = await downloadHistoryFile(fileId);
    }
    
    // 3. Trigger callback in app.js to merge cloud history with local history
    // Returns merged history if there were changes, or null if identical
    const mergedHistory = handleCloudDataSynced(cloudHistory);
    
    // 4. Save merged updates back to Google Drive
    if (fileId) {
      await updateHistoryFile(fileId, mergedHistory || localHistory);
    } else {
      await createHistoryFile(mergedHistory || localHistory);
    }
    
    return mergedHistory;
  } catch (err) {
    console.error('Error syncing with Google Drive:', err);
    throw err;
  }
}

// Search file inside Google Drive hidden appData folder
async function findHistoryFile() {
  const query = encodeURIComponent(`name='${CONFIG.DRIVE_FILE_NAME}'`);
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${query}&fields=files(id,name)`,
    {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    }
  );
  
  if (!response.ok) {
    throw new Error(`Drive list failed: ${response.statusText}`);
  }
  
  const result = await response.json();
  return result.files && result.files.length > 0 ? result.files[0].id : null;
}

// Download file JSON content
async function downloadHistoryFile(fileId) {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    }
  );
  
  if (!response.ok) {
    throw new Error(`Drive download failed: ${response.statusText}`);
  }
  
  return await response.json();
}

// Create new file inside Google Drive appData folder
async function createHistoryFile(historyData) {
  const metadata = {
    name: CONFIG.DRIVE_FILE_NAME,
    parents: ['appDataFolder']
  };
  
  // Multipart upload (Metadata + Media content)
  const boundary = 'focus_aura_boundary';
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;
  
  const body = 
    delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    delimiter +
    'Content-Type: application/json\r\n\r\n' +
    JSON.stringify(historyData) +
    closeDelimiter;
    
  const response = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body: body
    }
  );
  
  if (!response.ok) {
    throw new Error(`Drive create failed: ${response.statusText}`);
  }
  
  return await response.json();
}

// Update file content inside Google Drive appData folder
async function updateHistoryFile(fileId, historyData) {
  const response = await fetch(
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
  
  if (!response.ok) {
    throw new Error(`Drive update failed: ${response.statusText}`);
  }
  
  return await response.json();
}

// ==========================================================================
// Credentials Helper Methods
// ==========================================================================

export function loadGoogleClientId() {
  return localStorage.getItem(CONFIG.CLIENT_ID_KEY) || '';
}

export function saveGoogleClientId(id) {
  localStorage.setItem(CONFIG.CLIENT_ID_KEY, id);
  if (id) {
    initializeTokenClient(id);
  }
}

export function isUserLoggedIn() {
  return accessToken !== null;
}

function updateSyncStatus(status, text) {
  const indicator = document.getElementById('sync-status');
  if (!indicator) return;
  
  indicator.className = `sync-indicator ${status}`;
  indicator.querySelector('.sync-text').innerText = text;
}

function setupAuthEventListeners() {
  const loginBtn = document.getElementById('google-login-btn');
  const logoutBtn = document.getElementById('google-logout-btn');
  
  if (loginBtn) {
    loginBtn.addEventListener('click', () => {
      const clientId = loadGoogleClientId();
      
      if (!clientId) {
        alert('Please open App Settings (top right gear/slider icon) and input your Google API Client ID first!');
        // Open settings modal automatically
        const settingsModal = document.getElementById('settings-modal');
        if (settingsModal) settingsModal.classList.remove('hidden');
        return;
      }
      
      if (!tokenClient) {
        initializeTokenClient(clientId);
      }
      
      if (tokenClient) {
        tokenClient.requestAccessToken();
      }
    });
  }
  
  if (logoutBtn) {
    logoutBtn.addEventListener('click', handleLogout);
  }
  
  // Register Auth success trigger to start dynamic sync operations
  authCallback = async () => {
    const localData = localStorage.getItem('focus_aura_data');
    let localHistory = {};
    if (localData) {
      try {
        localHistory = JSON.parse(localData).history || {};
      } catch (e) {}
    }
    await syncDataWithGoogle(localHistory);
  };
}
