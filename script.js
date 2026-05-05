const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn, exec, execSync } = require('child_process');
const { StringDecoder } = require('string_decoder');

// Shared state + modules
const state = require(path.join(__dirname, 'modules', 'state'));
const installer = require(path.join(__dirname, 'modules', 'installer'));
const engine = require(path.join(__dirname, 'modules', 'download-engine'));

// HTML escape helper to prevent garbled UTF-8 display
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function buildYtDlpSpawnEnv() {
  const env = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8'
  };

  if (state.resolvedDenoPath && state.resolvedDenoPath !== 'deno') {
    try {
      const denoDir = path.dirname(state.resolvedDenoPath);
      if (denoDir && fs.existsSync(denoDir)) {
        env.PATH = `${denoDir}${path.delimiter}${process.env.PATH || ''}`;
      }
    } catch (e) {
      // Keep default PATH if deno path parsing fails.
    }
  }

  return env;
}

function addYtDlpJsRuntimeArgs(args) {
  if (state.resolvedDenoPath) {
    args.push('--js-runtimes', 'deno,node');
  }
}

// ============================================================================
// LOADING SCREEN HELPERS
// ============================================================================

function updateLoadingProgress(percent, status) {
  const loadingBar = document.getElementById('loadingBar');
  const loadingStatus = document.getElementById('loadingStatus');

  if (loadingBar) {
    loadingBar.style.width = `${percent}%`;
  }
  if (loadingStatus && status) {
    loadingStatus.textContent = status;
  }
}

function showLoadingScreen(status) {
  const loadingScreen = document.getElementById('loadingScreen');
  if (loadingScreen) {
    updateLoadingProgress(0, status || 'Please wait...');
    loadingScreen.classList.remove('hidden');
  }
}

function hideLoadingScreen() {
  const loadingScreen = document.getElementById('loadingScreen');
  if (loadingScreen) {
    // Complete the bar first
    updateLoadingProgress(100, 'Ready!');

    // Then fade out after a short delay
    setTimeout(() => {
      loadingScreen.classList.add('hidden');
    }, 300);
  }
}

// ============================================================================
// THEME MANAGEMENT - Matches Eagle's Theme Variants
// Supports: 9 themes — Blue (default), Dark, Gray, Light Gray, Light, Purple, Green, Rose, Amber
// ============================================================================

/**
 * Detect Eagle's current theme and return a normalized theme name.
 * Eagle returns uppercase strings like "DARK", "BLUE", "LIGHTGRAY", etc.
 * @returns {string} Normalized theme name
 */
function detectEagleTheme() {
  try {
    const eagleTheme = eagle.app.theme;
    switch (eagleTheme) {
      case 'DARK': return 'dark';
      case 'GRAY': return 'gray';
      case 'LIGHTGRAY': return 'light-gray';
      case 'LIGHT': return 'light';
      case 'PURPLE': return 'purple';
      case 'GREEN': return 'green';
      case 'ROSE': return 'rose';
      case 'AMBER': return 'amber';
      case 'BLUE': default: return 'blue';
    }
  } catch (e) { return 'blue'; }
}

/**
 * All possible theme classes (blue is default — no class needed)
 */
const ALL_THEME_CLASSES = ['theme-dark', 'theme-gray', 'theme-light-gray', 'theme-light',
                            'theme-purple', 'theme-green', 'theme-rose', 'theme-amber'];

/**
 * Apply theme to the document via CSS classes
 * @param {string} themeName - Normalized theme name (e.g. 'dark', 'light-gray')
 */
function applyThemeToDocument(themeName) {
  const html = document.documentElement;
  html.classList.remove(...ALL_THEME_CLASSES);
  // Blue is default — no class needed
  if (themeName && themeName !== 'blue') {
    html.classList.add(`theme-${themeName}`);
  }
  eagle.log.info('Theme applied to document: ' + themeName);
}

/**
 * Apply theme based on settings and Eagle's current theme
 * If settings.theme is 'auto', follow Eagle's theme
 * Otherwise use the manual selection
 */
function applyTheme() {
  const themeSetting = settings.theme || 'auto';
  if (themeSetting === 'auto') {
    applyThemeToDocument(detectEagleTheme());
  } else {
    applyThemeToDocument(themeSetting);
  }
}

/**
 * Setup listener for Eagle theme changes
 * Only applies if settings.theme is 'auto'
 */
function setupThemeListener() {
  if (eagle.onThemeChanged) {
    eagle.onThemeChanged(async (theme) => {
      eagle.log.info('Eagle theme changed to: ' + theme);
      // Only auto-switch if in auto mode
      if (settings.theme === 'auto') {
        applyTheme();
      }
    });
    eagle.log.info('Theme change listener registered');
  } else {
    eagle.log.warn('eagle.onThemeChanged not available');
  }
}

/**
 * Handle theme setting change from UI
 * @param {string} newTheme - 'auto', 'dark', 'blue', or 'purple'
 */
function setTheme(newTheme) {
  settings.theme = newTheme;
  applyTheme();
  saveSettings();
}

let folders = [];
let selectedFolder = null;
let selectedQuality = 'best';
let selectedFormat = 'mp4';
// Shared state: ytDlpPath, resolvedDenoPath, tempDir, downloadQueue, activeProcesses, settings
// are accessed via state.X (see modules/state.js)

// Kill a process and its entire tree (Windows: taskkill /T /F, others: SIGTERM)
function killProcess(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${proc.pid} /T /F`, { timeout: 3000, windowsHide: true });
    } else {
      proc.kill('SIGTERM');
    }
  } catch (e) {
    // Process already dead — ignore
  }
}

// Derived active download count — always accurate, never desyncs
function getActiveDownloadCount() {
  return state.downloadQueue.filter(i => i.status === 'downloading').length;
}

// Scale concurrent fragments inversely with active downloads
// 1 download → 8 fragments (max speed), 2 → 4, 3+ → 2 (preserve bandwidth)
function getConcurrentFragments() {
  const active = getActiveDownloadCount();
  if (active <= 1) return 8;
  if (active === 2) return 4;
  return 2;
}

// New features
let downloadHistory = [];
let clipboardInterval = null;
let lastClipboardContent = '';

// Settings with defaults
let settings = {
  // Data schema
  schemaVersion: 1,
  // Appearance
  theme: 'auto',  // 'auto', 'dark', 'blue', 'purple'
  alwaysOnTop: false,
  notifications: true,
  lastQuality: 'best',
  lastFormat: 'mp4',
  lastFolder: null,
  lastFolderName: '',
  // Legal
  legalAccepted: false,
  // Installation
  installOffered: false,
  // Smart features
  clipboardListener: true,
  autoDownload: false,
  duplicateDetection: true,
  showThumbnailPreview: true,
  maxConcurrentDownloads: 3,
  // Queue
  clearCompletedOnStartup: true,
  // Authentication
  useCookies: false,
  cookiesPath: '',
  // Playlists
  playlistDetection: true,
  // Auto-update policy
  autoCheckYtDlp: true,
  ytdlpStartupCheckAt: 0,
  ytdlpFailureCheckAt: 0,
  // Developer
  devTools: false,
  // UI State
  expandOptions: false,
  showQueueWarning: false,
  // First-run tutorial
  tutorialShown: false
};

const PLUGIN_VERSION = 'v3.1.0';

const SETTINGS_SCHEMA_VERSION = 1;
const HISTORY_SCHEMA_VERSION = 1;
const QUEUE_SCHEMA_VERSION = 1;

const AUTO_UPDATE_POLICY = {
  startupCheckIntervalMs: 24 * 60 * 60 * 1000, // 24h
  failureWindowMs: 45 * 60 * 1000,             // 45m
  failureThreshold: 2,
  failureCheckCooldownMs: 6 * 60 * 60 * 1000   // 6h
};

const YTDLP_STALE_PATTERNS = [
  'sign in to confirm you\'re not a bot',
  'unable to extract',
  'signature extraction failed',
  'player response',
  'nsig',
  'youtube said',
  'yt-dlp failed with code',
  'requested format not available',
  'no video formats'
];

let ytdlpFailureSignals = [];

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSettingsForSchema(loaded) {
  const merged = { ...settings, ...loaded };
  if (merged.theme === 'lightgray') merged.theme = 'light-gray';
  merged.schemaVersion = SETTINGS_SCHEMA_VERSION;
  merged.ytdlpStartupCheckAt = toFiniteNumber(merged.ytdlpStartupCheckAt, 0);
  merged.ytdlpFailureCheckAt = toFiniteNumber(merged.ytdlpFailureCheckAt, 0);
  merged.autoCheckYtDlp = merged.autoCheckYtDlp !== false;
  return merged;
}

function syncStateSettingsReference() {
  state.settings = settings;
}

function decodeVersionedItems(raw, key) {
  if (Array.isArray(raw)) {
    return { schemaVersion: 0, [key]: raw };
  }
  if (raw && typeof raw === 'object' && Array.isArray(raw[key])) {
    return {
      schemaVersion: toFiniteNumber(raw.schemaVersion, 0),
      [key]: raw[key]
    };
  }
  return { schemaVersion: 0, [key]: [] };
}

function markYtDlpCheckTimestamp(fieldName) {
  settings[fieldName] = Date.now();
  saveSettings();
}

function shouldRunTimedCheck(lastCheckAt, intervalMs) {
  return (Date.now() - toFiniteNumber(lastCheckAt, 0)) >= intervalMs;
}

function isYouTubeHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.includes('youtube.com') || host.includes('youtu.be') || host.includes('music.youtube.com');
  } catch {
    return false;
  }
}

function isLikelyYtDlpStaleness(errorMessage, url) {
  if (!errorMessage) return false;
  const msg = String(errorMessage).toLowerCase();
  const hasPattern = YTDLP_STALE_PATTERNS.some(pattern => msg.includes(pattern));
  if (!hasPattern) return false;
  return isYouTubeHost(url) || msg.includes('youtube');
}

async function maybeRunStartupYtDlpUpdateCheck() {
  if (!settings.autoCheckYtDlp || !state.ytDlpPath) return;
  if (!shouldRunTimedCheck(settings.ytdlpStartupCheckAt, AUTO_UPDATE_POLICY.startupCheckIntervalMs)) return;

  markYtDlpCheckTimestamp('ytdlpStartupCheckAt');
  try {
    await installer.checkYtDlpUpdate(true);
  } catch (e) {
    eagle.log.warn('Startup yt-dlp update check failed: ' + (e?.message || String(e)));
  }
}

function maybeRunFailureTriggeredYtDlpUpdateCheck(err, videoUrl) {
  if (!settings.autoCheckYtDlp || !state.ytDlpPath) return;
  const message = err?.message || String(err || '');
  if (!isLikelyYtDlpStaleness(message, videoUrl)) return;

  const now = Date.now();
  ytdlpFailureSignals.push(now);
  ytdlpFailureSignals = ytdlpFailureSignals.filter(ts => now - ts <= AUTO_UPDATE_POLICY.failureWindowMs);

  if (ytdlpFailureSignals.length < AUTO_UPDATE_POLICY.failureThreshold) return;
  if (!shouldRunTimedCheck(settings.ytdlpFailureCheckAt, AUTO_UPDATE_POLICY.failureCheckCooldownMs)) return;

  ytdlpFailureSignals = [];
  markYtDlpCheckTimestamp('ytdlpFailureCheckAt');
  eagle.log.warn('Detected repeated extractor-like failures; checking yt-dlp updates');
  installer.checkYtDlpUpdate(true).catch((e) => {
    eagle.log.warn('Failure-triggered yt-dlp update check failed: ' + (e?.message || String(e)));
  });
}

// Pending playlist data for modal
let pendingPlaylistData = null;

// Source tag mapping
const SOURCE_TAGS = {
  'youtube.com': 'YouTube',
  'youtu.be': 'YouTube',
  'vimeo.com': 'Vimeo',
  'twitter.com': 'Twitter',
  'x.com': 'Twitter',
  'tiktok.com': 'TikTok',
  'instagram.com': 'Instagram',
  'facebook.com': 'Facebook',
  'fb.watch': 'Facebook',
  'twitch.tv': 'Twitch',
  'dailymotion.com': 'Dailymotion',
  'reddit.com': 'Reddit',
  'v.redd.it': 'Reddit',
  'streamable.com': 'Streamable',
  'gfycat.com': 'Gfycat',
  'imgur.com': 'Imgur',
  'bilibili.com': 'Bilibili',
  'nicovideo.jp': 'NicoNico',
  'soundcloud.com': 'SoundCloud',
  'bandcamp.com': 'Bandcamp'
};

// Notification throttling
let lastNotificationTime = 0;
let pendingNotifications = [];
const NOTIFICATION_DELAY = 2000;

// Global error handler (use console since eagle.log isn't available yet)
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message, err.stack);
  // Try to log to Eagle if available
  if (typeof eagle !== 'undefined' && eagle.log) {
    try {
      eagle.log.error('Uncaught exception:', err.message, err.stack);
    } catch(e) {}
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  // Try to log to Eagle if available
  if (typeof eagle !== 'undefined' && eagle.log) {
    try {
      eagle.log.error('Unhandled rejection:', reason);
    } catch(e) {}
  }
});

// Initialize modules with callbacks (must happen before onPluginCreate)
installer.init({
  expandWindowForModal,
  registerModalOpen,
  registerModalClose,
  lockMinSizeForInstall,
  unlockMinSize,
  restoreWindowSize,
  showLegalDisclaimer,
  initializePlugin,
  showConfirmation,
  updateIndicator,
  showLoadingScreen,
  hideLoadingScreen,
});

engine.init({
  updateProgressOnly,
  updateQueueUI,
  queueNotification,
  addToHistory,
  escapeHtml,
  killProcess,
  getConcurrentFragments,
  processNextDownload,
  saveQueue,
  checkYtDlp,
  showStatus,
  cleanupTempFiles,
  isValidUrl,
});

eagle.onPluginCreate(async (plugin) => {
  eagle.log.info('Video Downloader ' + PLUGIN_VERSION + ' starting...');

  try {
    // Show initial loading state
    updateLoadingProgress(5, 'Starting...');

    // Pre-initialization: setup essentials
    updateLoadingProgress(10, 'Loading settings...');
    state.tempDir = await eagle.app.getPath('temp');
    // eagle.log.info('Temp directory: ' + state.tempDir);

    await loadSettings();
    state.settings = settings;
    updateLoadingProgress(20, 'Settings loaded');

    // Initialize theme after settings are loaded (so we know user preference)
    applyTheme();
    setupThemeListener();

    // Step 1: Check dependencies first
    updateLoadingProgress(30, 'Checking dependencies...');
    eagle.log.info('Checking dependencies...');
    const missing = await installer.checkDependencies();
    // eagle.log.info('Missing dependencies:', JSON.stringify(missing));

    // Step 2: Show install modal if critical dependencies are missing
    // Deno is YouTube-only — missing Deno does NOT block plugin startup for non-YouTube users
    if (missing.ytdlp || missing.ffmpeg) {
      hideLoadingScreen(); // Hide loading to show install modal
      const modalShown = installer.showInstallModal(missing);
      if (modalShown) {
        // eagle.log.info('Install modal shown, waiting for user action...');
        return; // Install modal will continue the flow
      }
    }

    updateLoadingProgress(50, 'Dependencies OK');

    // Step 3: Check if user has accepted legal terms
    if (!settings.legalAccepted) {
      hideLoadingScreen(); // Hide loading to show legal modal
      showLegalDisclaimer();
      return; // Legal modal will call initializePlugin() after acceptance
    }

    // All checks passed - proceed with initialization
    await initializePlugin();
    
  } catch (err) {
    const errorMsg = err.toString();
    const stackMsg = err.stack ? err.stack.toString() : 'No stack trace';
    eagle.log.error('INITIALIZATION FAILED: ' + errorMsg);
    eagle.log.error('Stack trace: ' + stackMsg);
    updateIndicator('Init failed', 'error');
  }
});

// ============================================================================
// MAIN INITIALIZATION FUNCTION
// Called after legal acceptance - either directly or from legal modal
// ============================================================================
async function initializePlugin() {
  try {
    updateLoadingProgress(55, 'Loading history...');
    await loadHistory();

    updateLoadingProgress(65, 'Loading queue...');
    await loadQueue();

    updateLoadingProgress(75, 'Loading folders...');
    await loadFolders();

    updateLoadingProgress(80, 'Checking yt-dlp...');
    const ytdlpFound = await checkYtDlp();

    updateLoadingProgress(90, 'Setting up UI...');
    setupEventListeners();

    // Wait for DOM to be fully ready before applying settings
    setTimeout(() => {
      applySettings();
      const feedbackVer = document.getElementById('feedbackVersion');
      if (feedbackVer) feedbackVer.textContent = PLUGIN_VERSION;
    }, 100);

    // Start clipboard listener if enabled
    if (settings.clipboardListener) {
      startClipboardListener();
    }

    // Cleanup any leftover temp files from previous sessions
    cleanupOldTempFiles();

    updateIndicator(ytdlpFound ? 'Ready' : 'yt-dlp missing', ytdlpFound ? 'success' : 'error');
    eagle.log.info('Plugin initialized successfully');

    // Hide loading screen
    hideLoadingScreen();

    // Non-blocking: check for yt-dlp updates after init
    if (ytdlpFound) {
      setTimeout(() => {
        maybeRunStartupYtDlpUpdateCheck();
      }, 3000);
    }
  } catch (err) {
    const errorMsg = err.toString();
    const stackMsg = err.stack ? err.stack.toString() : 'No stack trace';
    eagle.log.error('INITIALIZATION FAILED: ' + errorMsg);
    eagle.log.error('Stack trace: ' + stackMsg);
    updateIndicator('Init failed', 'error');
    hideLoadingScreen(); // Still hide on error
  }
}

// Cleanup when plugin is about to close
if (eagle.onPluginBeforeExit) {
  eagle.onPluginBeforeExit(async () => {
    const hasActive = () => state.downloadQueue.some(i => i.status === 'downloading');

    eagle.log.info('Plugin closing, ' + state.activeProcesses.size + ' active processes');

    // Stop clipboard listener
    stopClipboardListener();

    // Grace period: wait up to 5s for in-progress downloads to finish naturally
    if (hasActive()) {
      const deadline = Date.now() + 5000;
      while (hasActive() && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // Force-kill whatever remains — synchronous so kills complete before Eagle tears down
    const procs = [...state.activeProcesses.values()];
    state.activeProcesses.clear();
    eagle.log.info('Killing ' + procs.length + ' remaining processes');
    for (const proc of procs) {
      killProcess(proc);
    }

    // Delayed temp file cleanup after kills complete
    setTimeout(() => {
      state.downloadQueue.forEach(item => {
        if (item.tempFiles) cleanupTempFiles(item.tempFiles);
      });
    }, 2500);
  });
}

// Handle library switching - reload folders when user changes library
eagle.onLibraryChanged(async (libraryPath) => {
  eagle.log.info('Library changed to:', libraryPath);

  // Reload folders for the new library
  await loadFolders();

  // Clear folder selection (folder IDs are library-specific)
  selectedFolder = null;
  settings.lastFolder = null;
  settings.lastFolderName = '';
  saveSettings();

  const folderDisplay = document.getElementById('folderDisplay');
  if (folderDisplay) {
    folderDisplay.value = '';
  }

  updateOptionsHint();
  showStatus('Library changed - folders reloaded', 'info');
});

function cleanupOldTempFiles() {
  if (!state.tempDir) return;

  try {
    const files = fs.readdirSync(state.tempDir);
    const oldFiles = files.filter(f =>
      (f.startsWith('eagle_ytdlp_') || f.startsWith('eagle_video_') || f.startsWith('eagle_thumb_')) &&
      Date.now() - fs.statSync(path.join(state.tempDir, f)).mtimeMs > 3600000 // Older than 1 hour
    );

    oldFiles.forEach(f => {
      try {
        fs.unlinkSync(path.join(state.tempDir, f));
        // eagle.log.info('Cleaned up old temp file:', f);
      } catch (e) {}
    });

    // if (oldFiles.length > 0) {
    //   eagle.log.info(`Cleaned up ${oldFiles.length} old temp files`);
    // }
  } catch (e) {
    // eagle.log.warn('Could not cleanup old temp files:', e.message);
  }
}

async function loadSettings() {
  try {
    const settingsPath = path.join(__dirname, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf8');
      const loaded = JSON.parse(data);
      settings = normalizeSettingsForSchema(loaded);
      syncStateSettingsReference();
      // eagle.log.info('Settings loaded: ' + JSON.stringify(settings, null, 2));
    } else {
      // eagle.log.warn('No settings.json file found, using defaults');
      settings = normalizeSettingsForSchema(settings);
      syncStateSettingsReference();
    }

    // Sync devTools from manifest
    const manifestPath = path.join(__dirname, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      settings.devTools = manifest.devTools === true;
      // eagle.log.info('DevTools synced from manifest: ' + settings.devTools);
    }

    // Persist schema migrations/normalization immediately
    saveSettings();
  } catch(e) {
    eagle.log.error('Could not load settings:', e);
  }
}

function saveSettings() {
  try {
    const settingsPath = path.join(__dirname, 'settings.json');
    settings = normalizeSettingsForSchema(settings);
    syncStateSettingsReference();
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    // eagle.log.info('Settings saved: ' + JSON.stringify(settings, null, 2));
  } catch(e) {
    eagle.log.error('Could not save settings:', e);
  }
}

// ============ HISTORY MANAGEMENT ============

async function loadHistory() {
  try {
    const historyPath = path.join(__dirname, 'history.json');
    if (fs.existsSync(historyPath)) {
      const data = fs.readFileSync(historyPath, 'utf8');
      const parsed = JSON.parse(data);
      const decoded = decodeVersionedItems(parsed, 'items');
      downloadHistory = Array.isArray(decoded.items) ? decoded.items : [];
      if (decoded.schemaVersion !== HISTORY_SCHEMA_VERSION) {
        saveHistory();
      }
      // eagle.log.info('Loaded history: ' + downloadHistory.length + ' items');
    }
  } catch(e) {
    // eagle.log.warn('Could not load history:', e);
    downloadHistory = [];
  }
}

function saveHistory() {
  try {
    const historyPath = path.join(__dirname, 'history.json');
    // Keep only last 500 items
    if (downloadHistory.length > 500) {
      downloadHistory = downloadHistory.slice(-500);
    }
    const payload = {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      items: downloadHistory
    };
    fs.writeFileSync(historyPath, JSON.stringify(payload, null, 2));
  } catch(e) {
    eagle.log.error('Could not save history:', e);
  }
}

function addToHistory(item, failed = false, errorMessage = null) {
  const historyItem = {
    id: Date.now(),
    url: item.url,
    name: item.displayName || item.name || 'Unknown',
    thumbnail: item.thumbnailPreview || null,
    folder: settings.lastFolderName || null,
    folderId: item.folderIds?.[0] || null,
    tags: item.tags || [],
    quality: item.quality,
    format: item.format,
    date: new Date().toISOString(),
    // New fields for failed downloads
    failed: failed,
    error: errorMessage || null,
    fixSuggestion: failed ? engine.getFixSuggestion(errorMessage) : null
  };
  downloadHistory.unshift(historyItem);
  saveHistory();
  updateHistoryUI();
}



function updateHistoryUI() {
  const historyList = document.getElementById('historyList');
  if (!historyList) return;
  
  if (downloadHistory.length === 0) {
    historyList.innerHTML = '<div class="history-empty">No download history yet</div>';
    return;
  }
  
  let html = '';
  downloadHistory.slice(0, 50).forEach(item => {
    const date = new Date(item.date).toLocaleDateString();
    const thumbStyle = item.thumbnail ? `background-image: url('${item.thumbnail}')` : '';
    const failedClass = item.failed ? 'failed' : '';
    const statusIcon = item.failed ? '❌' : (item.thumbnail ? '' : '🎬');
    const escapedUrl = item.url.replace(/'/g, "\\'");
    
    if (item.failed) {
      // Failed download - show error and fix suggestion
      html += `
        <div class="history-item ${failedClass}" data-url="${item.url}">
          <div class="history-thumb failed-thumb" style="${thumbStyle}">${statusIcon}</div>
          <div class="history-info">
            <div class="history-name">${escapeHtml(item.name)}</div>
            <div class="history-error">⚠️ ${escapeHtml(item.error || 'Download failed')}</div>
            <div class="history-fix">${escapeHtml(item.fixSuggestion || 'Try downloading again')}</div>
            <div class="history-meta">${date} • ${item.quality} • ${item.format.toUpperCase()}</div>
          </div>
          <button class="history-redownload" onclick="redownloadFromHistory('${escapedUrl}')" title="Try again">↻</button>
        </div>
      `;
    } else {
      // Successful download
      html += `
        <div class="history-item" data-url="${item.url}">
          <div class="history-thumb" style="${thumbStyle}">${statusIcon}</div>
          <div class="history-info">
            <div class="history-name">${escapeHtml(item.name)}</div>
            <div class="history-meta">${date} • ${item.quality} • ${item.format.toUpperCase()}</div>
          </div>
          <button class="history-redownload" onclick="redownloadFromHistory('${escapedUrl}')" title="Download again">↻</button>
        </div>
      `;
    }
  });
  
  historyList.innerHTML = html;
}

window.redownloadFromHistory = function(url) {
  document.getElementById('videoUrl').value = url;
  validateUrl(url);
  fetchThumbnailPreview(url);
  showStatus('URL loaded from history', 'success');
};

// ============ QUEUE PERSISTENCE ============

async function loadQueue() {
  try {
    const queuePath = path.join(__dirname, 'queue.json');
    if (fs.existsSync(queuePath)) {
      const data = fs.readFileSync(queuePath, 'utf8');
      const parsed = JSON.parse(data);
      const decoded = decodeVersionedItems(parsed, 'items');
      let loadedQueue = Array.isArray(decoded.items) ? decoded.items : [];

      // Reset downloading status and clean stale thumbnails
      loadedQueue.forEach(item => {
        if (item.status === 'downloading') {
          item.status = 'pending';
          item.progress = 0;
        }
        if (item.thumbnailPreview && !item.thumbnailPreview.startsWith('http') && !fs.existsSync(item.thumbnailPreview)) {
          item.thumbnailPreview = null;
        }
      });

      // Filter out completed items if clearCompletedOnStartup is enabled
      if (settings.clearCompletedOnStartup) {
        loadedQueue = loadedQueue.filter(item => item.status !== 'completed');
      }

      state.downloadQueue.length = 0;
      state.downloadQueue.push(...loadedQueue);
      if (decoded.schemaVersion !== QUEUE_SCHEMA_VERSION) {
        saveQueue();
      }
      // eagle.log.info(`Loaded ${state.downloadQueue.length} queue items from disk`);

      // Update UI
      updateQueueUI();

      // Auto-resume pending downloads
      const pendingCount = state.downloadQueue.filter(i => i.status === 'pending').length;
      if (pendingCount > 0) {
        // eagle.log.info(`Found ${pendingCount} pending downloads, will resume...`);
        updateIndicator(`Resuming ${pendingCount} download${pendingCount > 1 ? 's' : ''}`, 'info');
        // Start processing after a short delay
        setTimeout(() => processNextDownload(), 500);
      }
    }
  } catch(e) {
    eagle.log.error('Failed to load queue:', e);
    state.downloadQueue.length = 0;
  }
}

function saveQueue() {
  try {
    const queuePath = path.join(__dirname, 'queue.json');
    // Keep only last 100 items to prevent file bloat
    let queueToSave = state.downloadQueue;
    if (queueToSave.length > 100) {
      queueToSave = queueToSave.slice(-100);
    }
    const payload = {
      schemaVersion: QUEUE_SCHEMA_VERSION,
      items: queueToSave
    };
    fs.writeFileSync(queuePath, JSON.stringify(payload, null, 2));
  } catch(e) {
    eagle.log.error('Failed to save queue:', e);
  }
}

// ============ CLIPBOARD LISTENER ============

async function startClipboardListener() {
  if (clipboardInterval) return;

  // eagle.log.info('Starting clipboard listener (auto-download:', settings.autoDownload, ')');

  // Initialize with current clipboard content to prevent auto-download of stale URLs
  try {
    lastClipboardContent = await eagle.clipboard.readText() || '';
    // eagle.log.info('Initialized clipboard monitor, ignoring existing clipboard content');
  } catch(e) {
    lastClipboardContent = '';
  }
  
  clipboardInterval = setInterval(async () => {
    try {
      const clipText = await eagle.clipboard.readText();
      if (clipText && clipText !== lastClipboardContent) {
        lastClipboardContent = clipText;
        const trimmed = clipText.trim();
        
        // Check if it's a valid URL
        if (isValidUrl(trimmed) && isVideoUrl(trimmed)) {
          const urlInput = document.getElementById('videoUrl');
          if (urlInput && urlInput.value !== trimmed) {
            urlInput.value = trimmed;
            validateUrl(trimmed);
            
            if (settings.autoDownload) {
              // Auto-download: fetch preview first to get title, then submit
              showStatus('Fetching video info...', 'info');
              updateIndicator('Auto-download', 'info');

              // Always fetch thumbnail data for queue, regardless of preview UI setting
              await fetchThumbnailPreview(trimmed);

              // Now submit the form - the title should be in dataset
              showStatus('Auto-downloading...', 'info');
              const form = document.getElementById('downloadForm');
              if (form) form.dispatchEvent(new Event('submit'));
            } else {
              fetchThumbnailPreview(trimmed);
              showStatus('URL detected from clipboard', 'info');
              updateIndicator('URL detected', 'success');
            }
          }
        }
      }
    } catch(e) {
      // Clipboard read can fail silently
    }
  }, 2000); // Optimized: 2s interval (50% less CPU, still very responsive)
}

function stopClipboardListener() {
  if (clipboardInterval) {
    clearInterval(clipboardInterval);
    clipboardInterval = null;
    // eagle.log.info('Stopped clipboard listener');
  }
}

function isVideoUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    // Check if it's a known video site
    const videoSites = Object.keys(SOURCE_TAGS);
    if (videoSites.some(site => hostname.includes(site.replace('www.', '')))) {
      return true;
    }
    // Check for direct video URLs
    const videoExts = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.mp3', '.m4a'];
    if (videoExts.some(ext => url.toLowerCase().includes(ext))) {
      return true;
    }
    return true; // Allow any URL, yt-dlp will handle it
  } catch {
    return false;
  }
}

// ============ DUPLICATE DETECTION ============

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // Remove common tracking parameters
    const paramsToRemove = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ref', 'feature', 'si', 'list'];
    paramsToRemove.forEach(p => u.searchParams.delete(p));
    // Normalize YouTube URLs
    if (u.hostname.includes('youtube.com') || u.hostname.includes('youtu.be')) {
      const videoId = u.searchParams.get('v') || u.pathname.replace('/', '');
      if (videoId) {
        return `youtube:${videoId}`;
      }
    }
    return u.origin + u.pathname + (u.search || '');
  } catch {
    return url.toLowerCase().trim();
  }
}

async function checkDuplicate(url) {
  if (!settings.duplicateDetection) return null;
  
  try {
    // Normalize URL for comparison
    const normalizedUrl = normalizeUrl(url);
    
    // Check in Eagle library
    const items = await eagle.item.get({ ext: ['mp4', 'webm', 'mkv', 'mov', 'mp3', 'm4a'] });
    
    for (const item of items) {
      if (item.url && normalizeUrl(item.url) === normalizedUrl) {
        return {
          exists: true,
          item: item,
          name: item.name
        };
      }
    }
    
    // Also check history
    const historyMatch = downloadHistory.find(h => normalizeUrl(h.url) === normalizedUrl);
    if (historyMatch) {
      return {
        exists: true,
        fromHistory: true,
        name: historyMatch.name
      };
    }
  } catch(e) {
    // eagle.log.warn('Duplicate check failed:', e);
  }
  
  return null;
}

// ============ THUMBNAIL PREVIEW ============

async function fetchThumbnailPreview(url) {
  // If already fetching this URL, return the existing promise
  if (state.pendingPreviews.has(url)) {
    return state.pendingPreviews.get(url);
  }

  const fetchPromise = _doFetchThumbnailPreview(url);
  state.pendingPreviews.set(url, fetchPromise);

  // Clean up after completion
  fetchPromise.finally(() => {
    state.pendingPreviews.delete(url);
  });

  return fetchPromise;
}

async function _doFetchThumbnailPreview(url) {
  // Always fetch thumbnail data for queue, even if preview UI is disabled
  if (!state.ytDlpPath) {
    eagle.log.warn('ytDlpPath is not set, attempting to find it...');
    const found = await checkYtDlp();
    if (!found) {
      eagle.log.error('Could not find yt-dlp');
      return null;
    }
    eagle.log.info('Found yt-dlp at:', state.ytDlpPath);
  }

  const previewContainer = document.getElementById('thumbnailPreview');
  if (!previewContainer) {
    eagle.log.warn('⚠ Preview container not found');
    return null;
  }

  // Show loading UI only if preview display is enabled
  if (settings.showThumbnailPreview) {
    previewContainer.innerHTML = '<div class="preview-loading">Loading preview...</div>';
    previewContainer.classList.add('show');
  }
  
  try {
    // Build args array for spawn (handles paths with spaces better)
    const args = [
      '--no-playlist',
      '--print', 'thumbnail',
      '--print', 'title',
      '--print', 'duration_string',
      '--skip-download',
      '--encoding', 'utf-8',
      '--no-colors',
      '--no-warnings',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];

    // Add cookies if enabled
    if (settings.useCookies && settings.cookiesPath && fs.existsSync(settings.cookiesPath)) {
      args.push('--cookies', settings.cookiesPath);
      // eagle.log.info('Preview using cookies:', settings.cookiesPath);
    }

    addYtDlpJsRuntimeArgs(args);

    args.push(url);

    const result = await new Promise((resolve, reject) => {
      const decoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      let stdout = '';
      let stderr = '';
      
      const proc = spawn(state.ytDlpPath, args, {
        windowsHide: true,
        env: buildYtDlpSpawnEnv()
      });

      const procKey = `preview-${Date.now()}`;
      state.activeProcesses.set(procKey, proc);

      const timeout = setTimeout(() => {
        state.activeProcesses.delete(procKey);
        killProcess(proc);
        reject(new Error('Preview timeout'));
      }, 30000);

      proc.stdout.on('data', (data) => { stdout += decoder.write(data); });
      proc.stderr.on('data', (data) => { stderr += stderrDecoder.write(data); });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        state.activeProcesses.delete(procKey);
        stdout += decoder.end(); // Flush any remaining bytes
        stderr += stderrDecoder.end();
        const lines = stdout.trim().split('\n');
        if (code !== 0) {
          const stderrLines = stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
          const stderrTail = (stderrLines[stderrLines.length - 1] || '').slice(0, 240);
          reject(new Error(stderrTail || `Preview exited with code ${code}`));
          return;
        }
        resolve({
          thumbnail: lines[0] || null,
          title: lines[1] || 'Unknown',
          duration: lines[2] || ''
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        state.activeProcesses.delete(procKey);
        reject(err);
      });
    });

    eagle.log.info('✓ Preview fetched - title:', result.title, 'thumbnail:', result.thumbnail ? 'yes' : 'no');

    if (result.thumbnail && result.thumbnail.startsWith('http')) {
      // Only show preview UI if setting is enabled
      if (settings.showThumbnailPreview) {
        previewContainer.innerHTML = `
          <img class="preview-thumb" src="${result.thumbnail}" alt="Thumbnail" onerror="this.style.display='none'">
          <div class="preview-info">
            <div class="preview-title">${escapeHtml(result.title)}</div>
            ${result.duration ? `<div class="preview-duration">${escapeHtml(result.duration)}</div>` : ''}
          </div>
        `;
      } else {
        // Hide preview but keep data stored
        previewContainer.classList.remove('show');
      }

      // IMPORTANT: Set dataset AFTER innerHTML to prevent it from being cleared
      previewContainer.dataset.thumbnail = result.thumbnail;
      previewContainer.dataset.title = result.title;

      // Update any queue item with this URL that doesn't have a thumbnail yet
      const matchingQueueItem = state.downloadQueue.find(item => item.url === url && !item.thumbnailPreview);
      if (matchingQueueItem) {
        matchingQueueItem.thumbnailPreview = result.thumbnail;
        updateQueueUI();
        saveQueue();
      }

      // Auto-fill video name if empty
      const nameInput = document.getElementById('videoName');
      if (nameInput && !nameInput.value) {
        nameInput.placeholder = result.title;
      }

      // Check for duplicates
      const duplicate = await checkDuplicate(url);
      if (duplicate && duplicate.exists) {
        showDuplicateWarning(duplicate);
      }

      return result.title;
    } else {
      // No thumbnail available
      if (settings.showThumbnailPreview) {
        previewContainer.innerHTML = '<div class="preview-error">No preview available</div>';
      }
      return null;
    }
  } catch(e) {
    eagle.log.warn('✗ Preview fetch failed:', e.message);
    eagle.log.error('Preview fetch error details:', e);
    if (settings.showThumbnailPreview) {
      previewContainer.innerHTML = '<div class="preview-error">Preview failed</div>';
    }
    return null;
  }
}

function showDuplicateWarning(duplicate) {
  const warning = document.getElementById('duplicateWarning');
  if (warning) {
    warning.innerHTML = `⚠️ This video may already exist${duplicate.name ? `: "${duplicate.name}"` : ''}`;
    warning.classList.add('show');
  }
}

function hideDuplicateWarning() {
  const warning = document.getElementById('duplicateWarning');
  if (warning) {
    warning.classList.remove('show');
  }
}

// ============ EXPORT/IMPORT SETTINGS ============

// Export/Import functions removed - not needed

function applySettings() {
  // eagle.log.info('Applying settings to UI: ' + JSON.stringify(settings, null, 2));

  // Theme selector (button grid)
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === (settings.theme || 'auto'));
  });

  // Apply toggle states
  const alwaysOnTopToggle = document.getElementById('alwaysOnTopToggle');
  if (alwaysOnTopToggle) {
    alwaysOnTopToggle.checked = settings.alwaysOnTop;
    // eagle.log.info('alwaysOnTop set to:', settings.alwaysOnTop);
  } else {
    // eagle.log.warn('alwaysOnTopToggle element not found');
  }

  const notificationsToggle = document.getElementById('notificationsToggle');
  if (notificationsToggle) notificationsToggle.checked = settings.notifications;
  
  // Concurrent downloads selector
  const maxConcurrentSelect = document.getElementById('maxConcurrentSelect');
  if (maxConcurrentSelect) maxConcurrentSelect.value = settings.maxConcurrentDownloads || 3;
  
  // New toggles
  const clipboardToggle = document.getElementById('clipboardListenerToggle');
  if (clipboardToggle) clipboardToggle.checked = settings.clipboardListener;
  
  const autoDownloadToggle = document.getElementById('autoDownloadToggle');
  if (autoDownloadToggle) autoDownloadToggle.checked = settings.autoDownload;
  
  const duplicateToggle = document.getElementById('duplicateDetectionToggle');
  if (duplicateToggle) duplicateToggle.checked = settings.duplicateDetection;
  
  const previewToggle = document.getElementById('thumbnailPreviewToggle');
  if (previewToggle) previewToggle.checked = settings.showThumbnailPreview;

  // DevTools toggle
  const devToolsToggle = document.getElementById('devToolsToggle');
  if (devToolsToggle) devToolsToggle.checked = settings.devTools;

  // Queue toggles
  const clearCompletedToggle = document.getElementById('clearCompletedToggle');
  if (clearCompletedToggle) clearCompletedToggle.checked = settings.clearCompletedOnStartup !== false; // Default true
  
  // Apply always on top setting
  if (settings.alwaysOnTop && eagle.window?.setAlwaysOnTop) {
    eagle.window.setAlwaysOnTop(true).catch(() => {});
  }
  
  // Apply last quality
  if (settings.lastQuality) {
    selectedQuality = settings.lastQuality;
    const qualitySelect = document.getElementById('qualitySelect');
    // eagle.log.info('Quality element exists:', !!qualitySelect);
    if (qualitySelect) {
      // eagle.log.info('Quality element current value:', qualitySelect.value);
      qualitySelect.value = settings.lastQuality;
      // eagle.log.info('Quality element after setting:', qualitySelect.value);
      // eagle.log.info('Quality set to: ' + settings.lastQuality);
    } else {
      // eagle.log.warn('qualitySelect element not found');
    }
  }
  
  // Apply last format
  if (settings.lastFormat) {
    selectedFormat = settings.lastFormat;
    const formatOptions = document.querySelectorAll('.format-option');
    // eagle.log.info('Format buttons found:', formatOptions.length);
    formatOptions.forEach(opt => {
      const isActive = opt.dataset.format === settings.lastFormat;
      // eagle.log.info('Format button:', opt.dataset.format, 'should be active:', isActive, 'currently has active class:', opt.classList.contains('active'));
      opt.classList.toggle('active', isActive);
    });
    // eagle.log.info('Format set to: ' + settings.lastFormat);
    // Show/hide quality based on format
    const qualitySelector = document.getElementById('qualitySelector');
    if (qualitySelector) qualitySelector.classList.toggle('hidden', settings.lastFormat === 'mp3');
    // Sync auto-mode format buttons
    syncAutoFormatButtons();
  }
  
  // Apply last folder
  if (settings.lastFolder && settings.lastFolderName) {
    selectedFolder = settings.lastFolder;
    const folderDisplay = document.getElementById('folderDisplay');
    // eagle.log.info('Folder element exists:', !!folderDisplay);
    if (folderDisplay) {
      // eagle.log.info('Folder element current value:', folderDisplay.value);
      folderDisplay.value = settings.lastFolderName;
      // eagle.log.info('Folder element after setting:', folderDisplay.value);
      // eagle.log.info('Folder set to: ' + settings.lastFolderName);
    }
  }
  
  // Update options hint
  updateOptionsHint();
  
  // Update history UI
  updateHistoryUI();
  
  // Show auto-download badge if enabled
  const autoDownloadBadge = document.getElementById('autoDownloadBadge');
  if (autoDownloadBadge) autoDownloadBadge.classList.toggle('show', settings.autoDownload);

  // Update auto-mode UI (hides manual input when both clipboard + auto-download enabled)
  updateAutoModeUI();
  
  // Apply cookies settings
  const useCookiesToggle = document.getElementById('useCookiesToggle');
  if (useCookiesToggle) useCookiesToggle.checked = settings.useCookies;
  
  const cookiesPathInput = document.getElementById('cookiesPathInput');
  if (cookiesPathInput) cookiesPathInput.value = settings.cookiesPath || '';
  
  updateCookiePathVisibility();
  
  // Apply playlist detection toggle
  const playlistDetectionToggle = document.getElementById('playlistDetectionToggle');
  if (playlistDetectionToggle) playlistDetectionToggle.checked = settings.playlistDetection !== false;
  
  // Final verification
  // const finalQuality = document.getElementById('qualitySelect')?.value;
  // const finalFormat = document.querySelector('.format-option.active')?.dataset.format;
  // const finalFolder = document.getElementById('folderDisplay')?.value;
  // eagle.log.info('FINAL UI STATE - Quality:', finalQuality, 'Format:', finalFormat, 'Folder:', finalFolder);
  // eagle.log.info('All settings applied successfully');
}

// Sync format button states between main and auto-mode toggles
function syncAutoFormatButtons() {
  document.querySelectorAll('.auto-format-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.format === selectedFormat);
  });
}

function syncMainFormatButtons() {
  document.querySelectorAll('.format-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.format === selectedFormat);
  });
  document.getElementById('qualitySelector')?.classList.toggle('hidden', selectedFormat === 'mp3');
}

// Toggle auto-mode UI — show indicator only when fully auto (clipboard + auto-download)
function updateAutoModeUI() {
  const hasClipboard = settings.clipboardListener;
  const isAutoMode = hasClipboard && settings.autoDownload;
  const mainInputSection = document.querySelector('.main-input-section');
  const autoModeIndicator = document.getElementById('autoModeIndicator');

  // Only show indicator when fully in auto-mode
  if (autoModeIndicator) {
    autoModeIndicator.classList.toggle('show', isAutoMode);
    autoModeIndicator.classList.remove('paused');
  }
  // Hide manual input when fully auto
  if (mainInputSection) {
    mainInputSection.classList.toggle('auto-mode', isAutoMode);
  }

  // Sync main-screen toggle state
  const mainSwitch = document.getElementById('autoModeSwitch');
  if (mainSwitch) mainSwitch.checked = settings.autoDownload;

  // Sync auto-mode button in options-row
  const autoModeBtn = document.getElementById('autoModeBtn');
  if (autoModeBtn) autoModeBtn.classList.toggle('active', isAutoMode);
}

function updateOptionsHint() {
  const hints = [];
  if (selectedFolder) hints.push(settings.lastFolderName);
  const tags = document.getElementById('tags').value.trim();
  if (tags) hints.push(`${tags.split(',').length} tags`);
  
  const hint = document.getElementById('optionsHint');
  hint.textContent = hints.length > 0 ? hints.join(' • ') : '';
}

async function checkYtDlp() {
  const ytdlpExe = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const possiblePaths = [state.ytDlpPath];

  try {
    const sharedBinDir = await installer.getSharedBinDir();
    possiblePaths.push(path.join(sharedBinDir, ytdlpExe));
  } catch {}

  possiblePaths.push(
    path.join(__dirname, 'yt-dlp.exe'),
    path.join(__dirname, 'Bin', 'yt-dlp.exe'),
    path.join(process.env.USERPROFILE || '', 'scoop', 'shims', 'yt-dlp.exe'),
    path.join(process.env.USERPROFILE || '', 'scoop', 'apps', 'yt-dlp', 'current', 'yt-dlp.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages', 'yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe', 'yt-dlp.exe'),
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin', 'yt-dlp.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'Scripts', 'yt-dlp.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'Scripts', 'yt-dlp.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python310', 'Scripts', 'yt-dlp.exe'),
    path.join(__dirname, 'yt-dlp'),
    path.join(__dirname, 'yt-dlp_macos'),
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    '/opt/homebrew/bin/yt-dlp'
  );

  for (const testPath of possiblePaths.filter(Boolean)) {
    try {
      if (fs.existsSync(testPath)) {
        const result = execSync(`"${testPath}" --version`, { timeout: 10000, encoding: 'utf8', windowsHide: true });
        if (result && result.trim()) {
          state.ytDlpPath = testPath;
          document.getElementById('ytDlpWarning').classList.remove('show');
          return true;
        }
      }
    } catch(e) {}
  }

  try {
    const result = execSync('yt-dlp --version', { timeout: 10000, encoding: 'utf8', windowsHide: true });
    if (result && result.trim()) {
      state.ytDlpPath = 'yt-dlp';
      document.getElementById('ytDlpWarning').classList.remove('show');
      return true;
    }
  } catch(e) {}

  document.getElementById('ytDlpWarning').classList.add('show');
  return false;
}

async function loadFolders() {
  try {
    // Retry once for intermittent Eagle "plugin-create" race on some builds.
    let result = null;
    let firstError = null;
    try {
      result = await eagle.folder.getAll();
    } catch (err) {
      firstError = err;
      const lower = String(err?.message || '').toLowerCase();
      const isPluginCreateRace = lower.includes('plugin-create') || lower.includes('plugin create');
      if (isPluginCreateRace) {
        await new Promise(resolve => setTimeout(resolve, 500));
        result = await eagle.folder.getAll();
      } else {
        throw err;
      }
    }
    // eagle.log.info('eagle.folder.getAll() returned: ' + typeof result);

    if (Array.isArray(result)) {
      // eagle.log.info('Result is array: ' + Array.isArray(result));
      // eagle.log.info('Result length: ' + result.length);

      // if (result.length > 0) {
      //   eagle.log.info('First folder object: ' + JSON.stringify(result[0], null, 2));
      //   eagle.log.info('First folder keys: ' + Object.keys(result[0]).join(', '));
      // }

      folders = result;
    } else {
      // eagle.log.warn('eagle.folder.getAll() returned null/undefined');
      folders = [];
    }

    if (firstError) {
      eagle.log.warn('Folder load recovered after retry: ' + (firstError?.message || String(firstError)));
    }

    renderFolderTree();
  } catch (err) {
    const lower = String(err?.message || '').toLowerCase();
    const isPluginCreateRace = lower.includes('plugin-create') || lower.includes('plugin create');
    if (isPluginCreateRace) {
      eagle.log.warn('Folder list unavailable due to plugin-create race; using fallback empty list');
    } else {
      eagle.log.error('Error loading folders: ' + err.message);
      eagle.log.error('Error stack: ' + err.stack);
    }
    folders = [];
    renderFolderTree();
  }
}

function buildFolderTree(folders) {
  // eagle.log.info('buildFolderTree called with', folders.length, 'folders');

  // Check if folders already have nested children structure
  if (folders.length > 0 && folders[0].children !== undefined) {
    // eagle.log.info('Folders already have children property - using as-is');
    // Filter to only root folders (no parent)
    const rootFolders = folders.filter(f => !f.parent);
    // eagle.log.info('Found', rootFolders.length, 'root folders');
    return rootFolders;
  }

  // Build tree from flat list
  // eagle.log.info('Building tree from flat folder list');
  const folderMap = {};
  const rootFolders = [];
  
  folders.forEach(folder => {
    folderMap[folder.id] = { ...folder, children: folder.children || [] };
  });
  
  folders.forEach(folder => {
    if (folder.parent && folderMap[folder.parent]) {
      folderMap[folder.parent].children.push(folderMap[folder.id]);
    } else if (!folder.parent) {
      rootFolders.push(folderMap[folder.id]);
    }
  });
  
  // eagle.log.info('Built tree with', rootFolders.length, 'root folders');
  return rootFolders;
}

function renderFolderTree() {
  const folderList = document.getElementById('folderList');
  if (!folderList) {
    // eagle.log.error('folderList element not found!');
    return;
  }

  // eagle.log.info('renderFolderTree called, folders.length: ' + folders.length);
  renderFilteredFolders('');
}

function renderFilteredFolders(searchTerm) {
  const folderList = document.getElementById('folderList');
  if (!folderList) return;
  
  const term = searchTerm.toLowerCase().trim();
  
  // Build flat list with hierarchy info for searching
  const flatList = flattenFolders(folders, 0);
  
  // Filter by search term
  let filtered = flatList;
  if (term) {
    filtered = flatList.filter(f => f.name.toLowerCase().includes(term));
  }
  
  // Always show "No Folder" option first (unless searching)
  let html = '';
  if (!term) {
    html = '<div class="folder-item" data-folder-id="">No Folder</div>';
  }

  if (filtered.length > 0) {
    filtered.forEach(folder => {
      const indent = term ? 0 : folder.level * 16; // No indent when searching
      html += `<div class="folder-item" data-folder-id="${folder.id}" style="padding-left: ${12 + indent}px;">${escapeHtml(folder.name)}</div>`;
    });
  } else if (term) {
    html = '<div class="folder-item no-results">No folders found</div>';
  } else {
    html += '<div class="folder-item no-results">No folders in library</div>';
  }
  
  folderList.innerHTML = html;
  
  // Attach click handlers
  folderList.querySelectorAll('.folder-item[data-folder-id]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const folderId = item.getAttribute('data-folder-id');
      let folderName = item.textContent.trim();
      // eagle.log.info('Folder selected:', folderId, folderName);
      selectFolder(folderId, folderName);
      // Clear search after selection
      const searchInput = document.getElementById('folderSearch');
      if (searchInput) searchInput.value = '';
    });
  });
}

function flattenFolders(folderList, level) {
  let result = [];
  
  if (!folderList || !Array.isArray(folderList)) return result;
  
  // First, separate root folders from children
  const rootFolders = folderList.filter(f => !f.parent);
  const childFolders = folderList.filter(f => f.parent);
  
  // Build a map for quick lookup
  const folderMap = {};
  folderList.forEach(f => { folderMap[f.id] = f; });
  
  // Recursive function to add folder and its children
  function addWithChildren(folder, lvl) {
    result.push({
      id: folder.id,
      name: folder.name,
      level: lvl
    });
    
    // Find children of this folder
    const children = childFolders.filter(f => f.parent === folder.id);
    children.forEach(child => addWithChildren(child, lvl + 1));
    
    // Also check folder.children array
    if (folder.children && Array.isArray(folder.children)) {
      folder.children.forEach(child => {
        if (!result.find(r => r.id === child.id)) {
          addWithChildren(child, lvl + 1);
        }
      });
    }
  }
  
  // Start with root folders
  rootFolders.forEach(folder => addWithChildren(folder, 0));
  
  // If no root folders found, just flatten all
  if (rootFolders.length === 0) {
    folderList.forEach(folder => {
      result.push({
        id: folder.id,
        name: folder.name,
        level: 0
      });
    });
  }
  
  return result;
}

function renderFolderItems(folderList, level) {
  let html = '';
  
  if (!folderList || !Array.isArray(folderList)) {
    // eagle.log.warn('renderFolderItems received invalid folderList:', typeof folderList);
    return html;
  }
  
  folderList.forEach(folder => {
    const indent = level * 16;
    const name = folder.name || 'Unnamed';
    const id = folder.id || '';

    html += `<div class="folder-item" data-folder-id="${id}" style="padding-left: ${12 + indent}px;">${escapeHtml(name)}</div>`;
    
    // Handle children - could be array or need to be fetched
    if (folder.children && Array.isArray(folder.children) && folder.children.length > 0) {
      html += renderFolderItems(folder.children, level + 1);
    }
  });
  
  return html;
}

function selectFolder(folderId, folderName) {
  // eagle.log.info('selectFolder called with:', folderId, folderName);
  selectedFolder = folderId || null;
  // eagle.log.info('selectedFolder is now:', selectedFolder);
  document.getElementById('folderDisplay').value = folderId ? folderName : '';
  document.getElementById('folderDropdown').classList.remove('show');
  
  settings.lastFolder = folderId;
  settings.lastFolderName = folderName;
  saveSettings();
  
  document.querySelectorAll('.folder-item').forEach(item => {
    item.classList.toggle('selected', item.dataset.folderId === (folderId || ''));
  });
  
  updateOptionsHint();
}

// --- Feedback email support ---
const CONTACT_EMAIL = 'karasuda.dev@gmail.com';
const EMAIL_COOLDOWN_MS = 2000;
let emailOpenInProgress = false;
let emailCooldownTimer = null;
let lastEmailOpenAt = 0;

function getEagleVersion() {
  try { return eagle.app.version || 'Unknown'; } catch (e) { return 'Unknown'; }
}

function getOSInfo() {
  try {
    const parts = [];
    if (eagle.os && typeof eagle.os.type === 'function') parts.push(eagle.os.type());
    else if (eagle.app && eagle.app.platform) parts.push(eagle.app.platform);
    if (eagle.os && typeof eagle.os.release === 'function') parts.push(eagle.os.release());
    if (eagle.app && eagle.app.arch) parts.push(eagle.app.arch);
    return parts.filter(Boolean).join(' ');
  } catch (e) { return 'Unknown'; }
}

function setEmailButtonsDisabled(disabled) {
  const bugBtn = document.getElementById('emailBugBtn');
  const suggestBtn = document.getElementById('emailSuggestBtn');
  if (bugBtn) bugBtn.disabled = disabled;
  if (suggestBtn) suggestBtn.disabled = disabled;
}

async function openSupportEmail(kind) {
  const now = Date.now();
  if (emailOpenInProgress || (now - lastEmailOpenAt) < EMAIL_COOLDOWN_MS) return;
  emailOpenInProgress = true;
  lastEmailOpenAt = now;
  if (emailCooldownTimer) clearTimeout(emailCooldownTimer);
  setEmailButtonsDisabled(true);

  const isBug = kind === 'bug';
  const pluginName = 'Video Downloader';
  const subject = `[${isBug ? 'Bug' : 'Suggestion'}] ${pluginName} ${PLUGIN_VERSION}`;
  const body = `${pluginName} ${PLUGIN_VERSION} | Eagle ${getEagleVersion()} | ${getOSInfo()}\n\n`;
  const mailto = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  try {
    showStatus('Opening email client...', 'info');
    if (eagle.shell && typeof eagle.shell.openExternal === 'function') {
      await eagle.shell.openExternal(mailto);
    } else {
      window.open(mailto);
    }
  } catch (e) {
    showStatus('Could not open email client', 'error');
  } finally {
    emailCooldownTimer = setTimeout(() => {
      emailOpenInProgress = false;
      setEmailButtonsDisabled(false);
    }, EMAIL_COOLDOWN_MS);
  }
}

function createSafeAddListener() {
  return (id, event, handler) => {
    const element = document.getElementById(id);
    if (element) element.addEventListener(event, handler);
  };
}

function setupEventListeners() {
  const safeAddListener = createSafeAddListener();

  wireWindowAndPanelListeners(safeAddListener);
  wireAutomationListeners(safeAddListener);
  wireMaintenanceListeners(safeAddListener);
  wireDependencyAndQueueListeners(safeAddListener);
  wireCookiesAndPlaylistSettingsListeners();
  wirePlaylistModalListeners();
  wireInputAndFormatListeners(safeAddListener);
  wireFolderAndGlobalListeners(safeAddListener);
}

function wireWindowAndPanelListeners(safeAddListener) {
  safeAddListener('minimizeBtn', 'click', () => {
    if (eagle.window?.minimize) eagle.window.minimize();
  });

  safeAddListener('closeBtn', 'click', async () => {
    try {
      if (typeof eagle.window.hide === 'function') await eagle.window.hide();
    } catch (e) {}
    window.close();
  });

  safeAddListener('settingsBtn', 'click', (e) => {
    const settingsBtn = document.getElementById('settingsBtn');
    if (settingsBtn && settingsBtn.classList.contains('disabled')) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    document.getElementById('settingsPanel')?.classList.add('show');
  });

  safeAddListener('closeSettingsBtn', 'click', () => {
    document.getElementById('settingsPanel')?.classList.remove('show');
  });

  document.querySelectorAll('.settings-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const targetPane = tab.dataset.tab;
      document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.settings-tab-pane').forEach(pane => pane.classList.remove('active'));
      tab.classList.add('active');
      const pane = document.querySelector(`[data-pane="${targetPane}"]`);
      if (pane) pane.classList.add('active');
    });
  });

  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      setTheme(btn.dataset.theme);
    });
  });

  safeAddListener('alwaysOnTopToggle', 'change', async function() {
    settings.alwaysOnTop = this.checked;
    saveSettings();
    try {
      if (eagle.window?.setAlwaysOnTop) {
        await eagle.window.setAlwaysOnTop(this.checked);
      }
    } catch (e) {}
  });

  safeAddListener('notificationsToggle', 'change', function() {
    settings.notifications = this.checked;
    saveSettings();
  });

  safeAddListener('maxConcurrentSelect', 'change', function() {
    settings.maxConcurrentDownloads = parseInt(this.value, 10) || 3;
    saveSettings();
  });

  safeAddListener('refreshFoldersBtn', 'click', async () => {
    showStatus('Refreshing folders...', 'info');
    await loadFolders();
    showStatus('Loaded ' + folders.length + ' folders', 'success');
  });

  safeAddListener('historyBtn', 'click', () => {
    document.getElementById('historyPanel')?.classList.add('show');
    updateHistoryUI();
  });

  safeAddListener('closeHistoryBtn', 'click', () => {
    document.getElementById('historyPanel')?.classList.remove('show');
  });

  safeAddListener('clearHistoryBtn', 'click', () => {
    showConfirmation(
      'Clear History',
      'Are you sure you want to clear all download history?',
      'This action cannot be undone.',
      () => {
        downloadHistory.length = 0;
        saveHistory();
        updateHistoryUI();
        showStatus('History cleared', 'success');
      }
    );
  });

  safeAddListener('viewLegalBtn', 'click', () => {
    const modal = document.getElementById('legalModal');
    const acceptBtn = document.getElementById('legalAcceptBtn');
    const declineBtn = document.getElementById('legalDeclineBtn');
    if (!modal || !acceptBtn || !declineBtn) return;

    registerModalOpen('legal');
    modal.classList.add('show');

    const handleClose = () => {
      modal.classList.remove('show');
      registerModalClose('legal');
      acceptBtn.removeEventListener('click', handleClose);
      declineBtn.removeEventListener('click', handleClose);
    };

    acceptBtn.addEventListener('click', handleClose);
    declineBtn.addEventListener('click', handleClose);
  });

  safeAddListener('helpBtn', 'click', () => {
    showHelpTutorial(false);
  });

  safeAddListener('emailBugBtn', 'click', () => openSupportEmail('bug'));
  safeAddListener('emailSuggestBtn', 'click', () => openSupportEmail('suggestion'));
}

function wireAutomationListeners(safeAddListener) {
  safeAddListener('clipboardListenerToggle', 'change', function() {
    settings.clipboardListener = this.checked;

    if (!this.checked) {
      settings.autoDownload = false;
      const autoDownloadToggle = document.getElementById('autoDownloadToggle');
      if (autoDownloadToggle) autoDownloadToggle.checked = false;
      const badge = document.getElementById('autoDownloadBadge');
      if (badge) badge.classList.remove('show');
      stopClipboardListener();
      showStatus('Clipboard listener disabled (auto-download also disabled)', 'info');
    } else {
      startClipboardListener();
      showStatus('Clipboard listener enabled', 'success');
    }

    saveSettings();
    updateAutoModeUI();
  });

  safeAddListener('autoDownloadToggle', 'change', function() {
    settings.autoDownload = this.checked;

    const badge = document.getElementById('autoDownloadBadge');
    if (badge) badge.classList.toggle('show', this.checked);

    const mainSwitch = document.getElementById('autoModeSwitch');
    if (mainSwitch) mainSwitch.checked = this.checked;

    if (this.checked) {
      settings.clipboardListener = true;
      const clipboardToggle = document.getElementById('clipboardListenerToggle');
      if (clipboardToggle) clipboardToggle.checked = true;
      startClipboardListener();
      showStatus('Auto-download enabled (clipboard listener activated)', 'success');
    }

    saveSettings();
    updateAutoModeUI();
  });

  safeAddListener('autoModeSwitch', 'change', function() {
    settings.autoDownload = this.checked;

    const settingsToggle = document.getElementById('autoDownloadToggle');
    if (settingsToggle) settingsToggle.checked = this.checked;

    const badge = document.getElementById('autoDownloadBadge');
    if (badge) badge.classList.toggle('show', this.checked);

    if (this.checked) {
      settings.clipboardListener = true;
      const clipboardToggle = document.getElementById('clipboardListenerToggle');
      if (clipboardToggle) clipboardToggle.checked = true;
      startClipboardListener();
    }

    saveSettings();
    updateAutoModeUI();
  });

  // Auto-mode button on main screen (toggles clipboard + auto-download together)
  safeAddListener('autoModeBtn', 'click', function() {
    const isAutoMode = settings.clipboardListener && settings.autoDownload;
    const enabling = !isAutoMode;

    settings.clipboardListener = enabling;
    settings.autoDownload = enabling;

    // Sync settings toggles
    const clipboardToggle = document.getElementById('clipboardListenerToggle');
    if (clipboardToggle) clipboardToggle.checked = enabling;
    const autoDownloadToggle = document.getElementById('autoDownloadToggle');
    if (autoDownloadToggle) autoDownloadToggle.checked = enabling;
    const badge = document.getElementById('autoDownloadBadge');
    if (badge) badge.classList.toggle('show', enabling);

    if (enabling) {
      startClipboardListener();
    } else {
      stopClipboardListener();
    }

    saveSettings();
    updateAutoModeUI();
  });

  const duplicateToggle = document.getElementById('duplicateDetectionToggle');
  if (duplicateToggle) {
    duplicateToggle.addEventListener('change', function() {
      settings.duplicateDetection = this.checked;
      saveSettings();
    });
  }

  safeAddListener('thumbnailPreviewToggle', 'change', function() {
    settings.showThumbnailPreview = this.checked;
    saveSettings();
    if (!this.checked) {
      document.getElementById('thumbnailPreview')?.classList.remove('show');
    }
  });
}

function wireMaintenanceListeners(safeAddListener) {
  safeAddListener('devToolsToggle', 'change', async function() {
    settings.devTools = this.checked;
    saveSettings();

    try {
      const manifestPath = path.join(__dirname, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.devTools = this.checked;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      showStatus('DevTools ' + (this.checked ? 'enabled' : 'disabled') + ' - restart plugin to apply', 'info');
    } catch (e) {
      showStatus('Failed to update DevTools setting', 'error');
    }
  });

  safeAddListener('openDevToolsBtn', 'click', () => {
    try {
      if (eagle.window && eagle.window.openDevTools) {
        eagle.window.openDevTools();
        showStatus('DevTools opened', 'info');
      } else {
        showStatus('Enable DevTools toggle above and restart plugin', 'info');
      }
    } catch (e) {
      showStatus('Could not open DevTools - enable toggle above and restart', 'error');
    }
  });

  safeAddListener('resetLegalBtn', 'click', () => {
    showConfirmation(
      'Reset Legal Agreement',
      'This will show the legal disclaimer again on next plugin start.',
      'You will need to accept the terms again to use the plugin.',
      () => {
        settings.legalAccepted = false;
        saveSettings();
        showStatus('Legal agreement reset - will show on next start', 'success');
      }
    );
  });

  safeAddListener('clearAllDataBtn', 'click', () => {
    showConfirmation(
      'Clear All Plugin Data',
      'This will delete ALL plugin data including settings, history, and queue.',
      'This action cannot be undone. The plugin will restart after clearing.',
      () => {
        try {
          const settingsPath = path.join(__dirname, 'settings.json');
          if (fs.existsSync(settingsPath)) fs.unlinkSync(settingsPath);
          const historyPath = path.join(__dirname, 'history.json');
          if (fs.existsSync(historyPath)) fs.unlinkSync(historyPath);
          const queuePath = path.join(__dirname, 'queue.json');
          if (fs.existsSync(queuePath)) fs.unlinkSync(queuePath);

          const resetSettings = normalizeSettingsForSchema({});
          Object.keys(settings).forEach(key => delete settings[key]);
          Object.assign(settings, resetSettings);
          syncStateSettingsReference();

          downloadHistory.length = 0;
          state.downloadQueue.length = 0;
          selectedFolder = null;

          showStatus('All data cleared - reloading plugin...', 'success');
          setTimeout(() => window.location.reload(), 1500);
        } catch (e) {
          eagle.log.error('Failed to clear data:', e);
          showStatus('Error clearing data - check console', 'error');
        }
      }
    );
  });
}

function wireDependencyAndQueueListeners(safeAddListener) {
  safeAddListener('updateYtDlpBtn', 'click', () => {
    installer.checkYtDlpUpdate(false);
  });

  safeAddListener('uninstallDepsBtn', 'click', () => {
    showConfirmation(
      'Uninstall Dependencies',
      'This will remove yt-dlp, FFmpeg, ffprobe, and Deno.',
      'You will need to reinstall dependencies to use the plugin again.',
      async () => {
        try {
          const { filesRemoved } = await installer.uninstallManagedDependencies();
          if (filesRemoved > 0) {
            showStatus('Dependencies removed (' + filesRemoved + ' files) - reloading...', 'success');
            setTimeout(() => window.location.reload(), 1500);
          } else {
            showStatus('No dependency files found to remove', 'info');
          }
        } catch (e) {
          eagle.log.error('Failed to uninstall dependencies:', e);
          showStatus('Error removing dependencies - check console', 'error');
        }
      }
    );
  });

  safeAddListener('clearCompletedToggle', 'change', function() {
    settings.clearCompletedOnStartup = this.checked;
    saveSettings();
  });
}

function wireCookiesAndPlaylistSettingsListeners() {
  document.getElementById('useCookiesToggle')?.addEventListener('change', function() {
    settings.useCookies = this.checked;
    saveSettings();
    updateCookiePathVisibility();

    if (this.checked) {
      if (settings.cookiesPath && fs.existsSync(settings.cookiesPath)) {
        showStatus('Cookies enabled: ' + path.basename(settings.cookiesPath), 'success');
      } else {
        showStatus('Cookies enabled - set file path below', 'info');
      }
    } else {
      showStatus('Cookies disabled', 'info');
    }
  });

  document.getElementById('browseCookiesBtn')?.addEventListener('click', async () => {
    try {
      const input = document.getElementById('cookiesPathInput');
      const currentPath = input?.value || '';

      const result = await eagle.dialog.showOpenDialog({
        title: 'Select Cookies File (Netscape format)',
        defaultPath: currentPath || undefined,
        buttonLabel: 'Select',
        filters: [
          { name: 'Text Files', extensions: ['txt'] },
          { name: 'All Files', extensions: ['*'] }
        ],
        properties: ['openFile']
      });

      if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
        const selectedPath = result.filePaths[0];
        const validation = validateCookiesFile(selectedPath);
        if (validation.valid) {
          settings.cookiesPath = selectedPath;
          if (input) input.value = selectedPath;
          saveSettings();
          showStatus('Cookies file set: ' + path.basename(selectedPath), 'success');
        } else {
          showStatus(validation.error, 'error');
        }
      }
    } catch (err) {
      eagle.log.error('Browse cookies error:', err);
      showStatus('Failed to open file dialog', 'error');
    }
  });

  document.getElementById('cookiesPathInput')?.addEventListener('change', function() {
    const trimmedPath = this.value.trim();

    if (!trimmedPath) {
      settings.cookiesPath = '';
      saveSettings();
      showStatus('Cookies path cleared', 'info');
      return;
    }

    if (fs.existsSync(trimmedPath)) {
      const validation = validateCookiesFile(trimmedPath);
      if (validation.valid) {
        settings.cookiesPath = trimmedPath;
        saveSettings();
        showStatus('Cookies file set: ' + path.basename(trimmedPath), 'success');
      } else {
        showStatus(validation.error, 'error');
      }
    } else {
      showStatus('File not found: ' + trimmedPath, 'error');
    }
  });

  document.getElementById('cookiesHelpBtn')?.addEventListener('click', () => {
    eagle.shell.openExternal('https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp');
  });

  document.getElementById('playlistDetectionToggle')?.addEventListener('change', function() {
    settings.playlistDetection = this.checked;
    saveSettings();
    showStatus(this.checked ? 'Playlist detection enabled' : 'Playlist detection disabled', 'info');
  });
}

function wirePlaylistModalListeners() {
  document.getElementById('playlistCancelBtn')?.addEventListener('click', () => {
    hidePlaylistModal();
    showStatus('Cancelled', 'info');
  });

  document.getElementById('playlistFirstBtn')?.addEventListener('click', async () => {
    if (!pendingPlaylistData) return;

    const firstItem = pendingPlaylistData.info.items[0];
    const originalUrl = pendingPlaylistData.url;
    hidePlaylistModal();

    if (!firstItem) return;

    let videoUrl = firstItem.url;
    if (!videoUrl || videoUrl === originalUrl) {
      try {
        const urlObj = new URL(originalUrl);
        urlObj.searchParams.delete('list');
        urlObj.searchParams.delete('index');
        videoUrl = urlObj.toString();
      } catch {
        videoUrl = originalUrl;
      }
    }

    const tags = document.getElementById('tags').value.trim();
    const tagArray = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];
    const folderIds = selectedFolder ? [selectedFolder] : [];

    addToQueue(videoUrl, firstItem.title, folderIds, tagArray, '', '', '');
    clearFormAfterSubmit();
  });

  document.getElementById('playlistAllBtn')?.addEventListener('click', async () => {
    if (!pendingPlaylistData) return;

    const items = pendingPlaylistData.info.items;
    hidePlaylistModal();
    showStatus(`Adding ${items.length} videos to queue...`, 'info');

    const tags = document.getElementById('tags').value.trim();
    const tagArray = tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [];
    const folderIds = selectedFolder ? [selectedFolder] : [];

    let addedCount = 0;
    for (const item of items) {
      const videoUrl = item.url || `https://www.youtube.com/watch?v=${item.id}`;
      if (!isDuplicateUrl(videoUrl)) {
        addToQueue(videoUrl, item.title, folderIds, [...tagArray], '', '', '');
        addedCount++;
      }
    }

    clearFormAfterSubmit();
    showStatus(`Added ${addedCount} videos to queue`, 'success');
  });

  document.getElementById('togglePreviewBtn')?.addEventListener('click', () => {
    const list = document.getElementById('playlistPreviewList');
    const btn = document.getElementById('togglePreviewBtn');
    if (!list || !btn) return;

    if (list.classList.contains('show')) {
      list.classList.remove('show');
      btn.textContent = 'Show';
    } else {
      list.classList.add('show');
      btn.textContent = 'Hide';
    }
  });

  document.getElementById('playlistModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'playlistModal') hidePlaylistModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const modal = document.getElementById('playlistModal');
    if (modal && modal.classList.contains('show')) {
      hidePlaylistModal();
    }
  });
}

function wireInputAndFormatListeners(safeAddListener) {
  safeAddListener('moreOptionsToggle', 'click', function() {
    this.classList.toggle('expanded');
    document.getElementById('moreOptions')?.classList.toggle('show');
  });

  safeAddListener('pasteBtn', 'click', async () => {
    try {
      const clipboardText = await eagle.clipboard.readText();
      eagle.log.info('Paste button clicked, clipboard: ' + (clipboardText ? 'has content' : 'empty'));

      if (clipboardText && isValidUrl(clipboardText.trim())) {
        const url = clipboardText.trim();
        document.getElementById('videoUrl').value = url;
        validateUrl(url);
        fetchThumbnailPreview(url);
        showStatus('URL pasted', 'success');
      } else {
        showStatus('No valid URL in clipboard', 'error');
      }
    } catch (e) {
      showStatus('Failed to read clipboard', 'error');
      eagle.log.error('Paste button error: ' + (e?.message || String(e)));
    }
  });

  const videoUrlInput = document.getElementById('videoUrl');
  if (videoUrlInput) {
    videoUrlInput.addEventListener('input', (e) => {
      validateUrl(e.target.value);
      hideDuplicateWarning();
    });

    let previewTimeout = null;
    const handleUrlChange = (e) => {
      const url = e.target.value.trim();
      if (e.type === 'input') {
        clearTimeout(previewTimeout);
        previewTimeout = setTimeout(() => {
          if (isValidUrl(url)) fetchThumbnailPreview(url);
        }, 500);
      } else if (isValidUrl(url)) {
        fetchThumbnailPreview(url);
      }
    };

    videoUrlInput.addEventListener('change', handleUrlChange);
    videoUrlInput.addEventListener('input', handleUrlChange);
    videoUrlInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('downloadForm')?.dispatchEvent(new Event('submit'));
      }
    });
  }

  document.querySelectorAll('.format-option').forEach(option => {
    option.addEventListener('click', function() {
      document.querySelectorAll('.format-option').forEach(o => o.classList.remove('active'));
      this.classList.add('active');
      selectedFormat = this.dataset.format;
      settings.lastFormat = selectedFormat;
      saveSettings();
      syncAutoFormatButtons();
      document.getElementById('qualitySelector')?.classList.toggle('hidden', selectedFormat === 'mp3');
    });
  });

  document.querySelectorAll('.auto-format-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.auto-format-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      selectedFormat = this.dataset.format;
      settings.lastFormat = selectedFormat;
      saveSettings();
      syncMainFormatButtons();
    });
  });

  safeAddListener('qualitySelect', 'change', function() {
    selectedQuality = this.value;
    settings.lastQuality = selectedQuality;
    saveSettings();
  });
}

function wireFolderAndGlobalListeners(safeAddListener) {
  const folderDisplayEl = document.getElementById('folderDisplay');
  const folderDropdownEl = document.getElementById('folderDropdown');
  const folderSearchEl = document.getElementById('folderSearch');

  if (folderDisplayEl && folderDropdownEl) {
    folderDisplayEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      folderDropdownEl.classList.toggle('show');
      if (folderDropdownEl.classList.contains('show') && folderSearchEl) {
        setTimeout(() => folderSearchEl.focus(), 50);
      }
    });
  }

  const folderDisplayContainer = document.querySelector('.folder-display');
  if (folderDisplayContainer && folderDropdownEl) {
    folderDisplayContainer.addEventListener('click', (e) => {
      if (e.target.id === 'clearFolder') return;
      e.preventDefault();
      e.stopPropagation();
      folderDropdownEl.classList.add('show');
      if (folderSearchEl) setTimeout(() => folderSearchEl.focus(), 50);
    });
  }

  if (folderSearchEl) {
    folderSearchEl.addEventListener('input', (e) => {
      renderFilteredFolders(e.target.value);
    });

    folderSearchEl.addEventListener('click', (e) => e.stopPropagation());

    folderSearchEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (folderDropdownEl) folderDropdownEl.classList.remove('show');
      folderSearchEl.value = '';
      renderFilteredFolders('');
    });
  }

  safeAddListener('clearFolder', 'click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    selectFolder('', '');
    document.getElementById('folderDropdown')?.classList.remove('show');
    const search = document.getElementById('folderSearch');
    if (search) {
      search.value = '';
      renderFilteredFolders('');
    }
  });

  safeAddListener('tags', 'change', updateOptionsHint);

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.folder-selector')) {
      const dropdown = document.getElementById('folderDropdown');
      if (dropdown) dropdown.classList.remove('show');
      const searchEl = document.getElementById('folderSearch');
      if (searchEl && searchEl.value) {
        searchEl.value = '';
        renderFilteredFolders('');
      }
    }
    if (!e.target.closest('.settings-panel') && !e.target.closest('.settings-btn')) {
      document.getElementById('settingsPanel')?.classList.remove('show');
    }
    if (!e.target.closest('.history-panel') && !e.target.closest('.history-btn')) {
      document.getElementById('historyPanel')?.classList.remove('show');
    }
  });

  safeAddListener('ytDlpLink', 'click', (e) => {
    e.preventDefault();
    eagle.shell.openExternal('https://github.com/yt-dlp/yt-dlp#installation');
  });

  safeAddListener('autoInstallBtn', 'click', async () => {
    const missing = await installer.checkDependencies();
    if (missing.ytdlp || missing.ffmpeg) {
      installer.showInstallModal(missing);
    } else {
      showStatus('Dependencies already installed!', 'success');
      document.getElementById('ytDlpWarning')?.classList.remove('show');
    }
  });

  safeAddListener('downloadForm', 'submit', handleSubmit);
  safeAddListener('clearCompletedBtn', 'click', clearCompleted);
}

function isValidUrl(string) {
  if (!string) return false;
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateUrl(url) {
  const validation = document.getElementById('urlValidation');
  
  if (!url || url.length === 0) {
    validation.className = 'url-validation';
    validation.innerHTML = '';
    return false;
  }
  
  if (isValidUrl(url)) {
    validation.className = 'url-validation valid';
    validation.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    return true;
  } else {
    validation.className = 'url-validation invalid';
    validation.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
    return false;
  }
}

function normalizeUrlForQueue(url) {
  try {
    const urlObj = new URL(url);
    ['t', 'feature', 'start_radio', 'si'].forEach(p => urlObj.searchParams.delete(p));
    // Keep 'list' param for playlist detection but remove for queue dedup
    return urlObj.toString();
  } catch {
    return url;
  }
}

function isDuplicateUrl(url) {
  const normalized = normalizeUrlForQueue(url);
  return state.downloadQueue.some(item => {
    return normalizeUrlForQueue(item.url) === normalized &&
           ['pending', 'downloading', 'error', 'cancelled'].includes(item.status);
  });
}

// ============ PLAYLIST DETECTION ============

// Quick check if URL might be a playlist (before expensive yt-dlp call)
function isPlaylistUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    
    // YouTube playlist indicators
    if (host.includes('youtube.com') || host.includes('youtu.be')) {
      if (parsed.searchParams.has('list')) return true;
      if (parsed.pathname.includes('/playlist')) return true;
    }
    
    // Vimeo showcase/album
    if (host.includes('vimeo.com')) {
      if (parsed.pathname.includes('/showcase/')) return true;
      if (parsed.pathname.includes('/album/')) return true;
    }
    
    // Soundcloud sets
    if (host.includes('soundcloud.com')) {
      if (parsed.pathname.includes('/sets/')) return true;
    }
    
    return false;
  } catch {
    return false;
  }
}

// Validate cookies file - basic checks only, yt-dlp will validate format
function validateCookiesFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { valid: false, error: 'File not found' };
    }
    
    const stats = fs.statSync(filePath);
    
    // Check file size
    if (stats.size === 0) {
      return { valid: false, error: 'File is empty' };
    }
    
    if (stats.size > 50 * 1024 * 1024) { // 50MB max
      return { valid: false, error: 'File too large' };
    }
    
    // Accept .txt or no extension (some tools export without extension)
    const ext = path.extname(filePath).toLowerCase();
    if (ext && ext !== '.txt') {
      return { valid: false, error: 'Should be a .txt file' };
    }
    
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

// Show/hide cookie path setting based on toggle
function updateCookiePathVisibility() {
  const pathSetting = document.getElementById('cookiePathSetting');
  if (pathSetting) {
    pathSetting.style.display = settings.useCookies ? 'flex' : 'none';
  }
}

// Check playlist info using yt-dlp --flat-playlist
async function checkPlaylistInfo(url) {
  return new Promise((resolve) => {
    if (!state.ytDlpPath) {
      resolve({ isPlaylist: false, count: 1, items: [] });
      return;
    }
    
    // Build args array
    const args = ['--flat-playlist', '--dump-json', '--no-warnings', '--ignore-errors', '--encoding', 'utf-8', '--no-colors'];
    
    // Add cookies if enabled
    if (settings.useCookies && settings.cookiesPath && fs.existsSync(settings.cookiesPath)) {
      args.push('--cookies', settings.cookiesPath);
    }

    addYtDlpJsRuntimeArgs(args);

    args.push(url);

    let output = '';
    let errorOutput = '';
    
    const proc = spawn(state.ytDlpPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildYtDlpSpawnEnv()
    });

    const procKey = `playlist-${Date.now()}`;
    state.activeProcesses.set(procKey, proc);

    // Timeout after 30 seconds
    const timeout = setTimeout(() => {
      state.activeProcesses.delete(procKey);
      killProcess(proc);
      resolve({ isPlaylist: false, count: 1, items: [] });
    }, 30000);

    proc.stdout.on('data', (data) => {
      output += data.toString('utf8');
    });

    proc.stderr.on('data', (data) => {
      errorOutput += data.toString('utf8');
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      state.activeProcesses.delete(procKey);

      try {
        // Each video in playlist outputs one JSON line
        const lines = output.trim().split('\n').filter(line => line.trim());
        const items = [];

        for (const line of lines) {
          try {
            const json = JSON.parse(line);
            items.push({
              id: json.id,
              title: json.title || json.id,
              url: json.url || json.webpage_url || `https://www.youtube.com/watch?v=${json.id}`,
              duration: json.duration
            });
          } catch (e) {
            // Skip non-JSON lines
          }
        }

        const isPlaylist = items.length > 1;

        resolve({
          isPlaylist,
          count: items.length,
          items: items
        });
      } catch (err) {
        resolve({ isPlaylist: false, count: 1, items: [] });
      }
    });

    proc.on('error', () => {
      clearTimeout(timeout);
      resolve({ isPlaylist: false, count: 1, items: [] });
    });
  });
}

// Show playlist confirmation modal
function showPlaylistModal(playlistInfo, originalUrl) {
  pendingPlaylistData = { info: playlistInfo, url: originalUrl };

  const modal = document.getElementById('playlistModal');
  const countEl = document.getElementById('playlistCount');
  const previewList = document.getElementById('playlistPreviewList');

  if (!modal || !countEl || !previewList) {
    // eagle.log.error('Playlist modal elements not found');
    return;
  }

  registerModalOpen('playlist');
  
  // Update count
  countEl.textContent = playlistInfo.count;
  
  // Populate preview list (first 20 items max)
  previewList.innerHTML = '';
  const itemsToShow = playlistInfo.items.slice(0, 20);
  itemsToShow.forEach((item, index) => {
    const div = document.createElement('div');
    div.className = 'playlist-preview-item';
    div.innerHTML = `<span class="item-index">${index + 1}.</span> ${escapeHtml(item.title || item.id)}`;
    previewList.appendChild(div);
  });
  
  if (playlistInfo.items.length > 20) {
    const more = document.createElement('div');
    more.className = 'playlist-preview-item';
    more.style.color = '#666';
    more.textContent = `... and ${playlistInfo.items.length - 20} more`;
    previewList.appendChild(more);
  }
  
  // Reset preview state
  previewList.classList.remove('show');
  const toggleBtn = document.getElementById('togglePreviewBtn');
  if (toggleBtn) toggleBtn.textContent = 'Show';
  
  // Show modal
  modal.classList.add('show');
  updateIndicator('Playlist detected', 'info');
}

// Hide playlist modal
function hidePlaylistModal() {
  const modal = document.getElementById('playlistModal');
  if (modal) modal.classList.remove('show');
  registerModalClose('playlist');
  pendingPlaylistData = null;
  updateIndicator('Ready', 'success');
}

async function handleSubmit(e) {
  e.preventDefault();

  const videoUrl = document.getElementById('videoUrl').value.trim();
  let videoName = document.getElementById('videoName').value.trim();
  const tagsInput = document.getElementById('tags').value.trim();
  const annotation = '';
  const thumbnailUrl = '';

  // Get thumbnail preview data if available
  const previewEl = document.getElementById('thumbnailPreview');
  let thumbnailPreview = previewEl?.dataset?.thumbnail || null;
  let previewTitle = previewEl?.dataset?.title || null;

  // If there's a pending preview fetch for this URL, wait for it
  if (!thumbnailPreview && state.pendingPreviews.has(videoUrl)) {
    try {
      await state.pendingPreviews.get(videoUrl);
      // Re-read the data after fetch completes
      thumbnailPreview = previewEl?.dataset?.thumbnail || null;
      previewTitle = previewEl?.dataset?.title || null;
    } catch (e) {
      // Preview failed, continue without it
    }
  }

  // Use preview title if no custom name provided
  if (!videoName && previewTitle) {
    videoName = previewTitle;
  }
  
  if (!videoUrl) {
    showStatus('Please enter a URL', 'error');
    return;
  }
  
  if (!isValidUrl(videoUrl)) {
    showStatus('Invalid URL', 'error');
    return;
  }
  
  if (isDuplicateUrl(videoUrl)) {
    showStatus('Already in queue', 'error');
    return;
  }
  
  // Check if URL might be a playlist
  if (settings.playlistDetection && isPlaylistUrl(videoUrl)) {
    showStatus('Checking playlist...', 'info');
    updateIndicator('Checking...', 'info');
    
    const playlistInfo = await checkPlaylistInfo(videoUrl);
    
    if (playlistInfo.isPlaylist && playlistInfo.count > 1) {
      // Show confirmation modal
      showPlaylistModal(playlistInfo, videoUrl);
      return;
    }
  }
  
  // Not a playlist or single video - proceed normally
  const tags = tagsInput ? tagsInput.split(',').map(t => t.trim()).filter(t => t) : [];
  const folderIds = selectedFolder ? [selectedFolder] : [];

  // eagle.log.info('Submitting download with:');
  // eagle.log.info('- URL:', videoUrl);
  // eagle.log.info('- videoName:', videoName);
  // eagle.log.info('- previewTitle:', previewTitle);
  // eagle.log.info('- selectedFolder variable:', selectedFolder);
  // eagle.log.info('- folderIds array:', folderIds);
  // eagle.log.info('- tags:', tags);

  addToQueue(videoUrl, videoName, folderIds, tags, annotation, thumbnailUrl, thumbnailPreview);
  
  // Clear form and preview
  clearFormAfterSubmit();
}

// Clear form after submit
function clearFormAfterSubmit() {
  document.getElementById('videoUrl').value = '';
  document.getElementById('videoName').value = '';
  document.getElementById('videoName').placeholder = 'Leave empty to use video title';
  document.getElementById('thumbnailPreview').classList.remove('show');
  document.getElementById('thumbnailPreview').innerHTML = '';
  document.getElementById('thumbnailPreview').dataset.title = '';
  document.getElementById('thumbnailPreview').dataset.thumbnail = '';
  hideDuplicateWarning();
  validateUrl('');
}

function addToQueue(videoUrl, videoName, folderIds, tags, annotation, thumbnailUrl, thumbnailPreview) {
  const maxQueue = 20; // Max items in queue
  const pending = state.downloadQueue.filter(i => i.status === 'pending' || i.status === 'downloading').length;
  
  if (pending >= maxQueue) {
    showStatus(`Queue full (max ${maxQueue})`, 'error');
    return;
  }
  
  // Use provided name, otherwise it will be fetched during download
  const initialName = videoName && videoName.length > 0 ? videoName : 'Fetching...';

  // eagle.log.info('addToQueue - videoName param:', videoName);
  // eagle.log.info('addToQueue - initialName:', initialName);
  
  const queueItem = {
    id: Date.now() + Math.random(),
    url: videoUrl,
    name: initialName,
    displayName: initialName,
    quality: selectedQuality,
    format: selectedFormat,
    folderIds,
    tags,
    annotation,
    thumbnailUrl,
    thumbnailPreview,
    status: 'pending',
    progress: 0,
    error: null,
    tempFiles: [],
    stallCount: 0
  };

  state.downloadQueue.push(queueItem);
  saveQueue();
  updateQueueUI();
  processNextDownload();
  showStatus('Added to queue', 'success');
}

async function processNextDownload() {
  const maxConcurrent = settings.maxConcurrentDownloads || 3;
  const activeCount = getActiveDownloadCount();
  if (activeCount >= maxConcurrent) return;

  const nextItem = state.downloadQueue.find(item => item.status === 'pending');
  if (!nextItem) {
    const currentActive = getActiveDownloadCount();
    updateIndicator(currentActive > 0 ? `Downloading ${currentActive}` : 'Ready', currentActive > 0 ? 'info' : 'success');
    return;
  }

  eagle.log.info('Starting download: ' + nextItem.url);

  nextItem.status = 'downloading';
  nextItem.progress = 0;  // Reset progress when starting download
  updateQueueUI();
  updateIndicator(`Downloading ${getActiveDownloadCount()}`, 'info');

  queueNotification('Download Started', nextItem.displayName);

  try {
    await engine.downloadVideo(nextItem);
    eagle.log.info('Download completed: ' + nextItem.displayName);
    nextItem.status = 'completed';
    nextItem.progress = 100;

    // Add to download history
    addToHistory(nextItem);

    showStatus('Added to Eagle!', 'success');
    queueNotification('Complete', nextItem.displayName);
  } catch (err) {
    if (err.message === 'stalled' && (nextItem.stallCount || 0) < 3) {
      // Auto-requeue stalled downloads (up to 3 times)
      nextItem.stallCount = (nextItem.stallCount || 0) + 1;
      nextItem.status = 'pending';
      nextItem.progress = 0;
      eagle.log.warn(`Download stalled (attempt ${nextItem.stallCount}/3), re-queuing: ${nextItem.displayName}`);
      updateQueueUI();
      state.activeProcesses.delete(nextItem.id);
      setTimeout(processNextDownload, 300);
      return;
    } else if (err.message !== 'cancelled') {
      eagle.log.error('Download failed: ' + nextItem.url);
      eagle.log.error('Error: ' + (err.message || 'No message'));
      maybeRunFailureTriggeredYtDlpUpdateCheck(err, nextItem.url);
      nextItem.status = 'error';
      if (err.message === 'stalled') {
        nextItem.error = 'Stalled 3 times. Check your network connection or try a different quality.';
      } else {
        nextItem.error = engine.getDetailedErrorMessage(err);
      }

      // Add failed download to history with error and fix suggestion
      addToHistory(nextItem, true, nextItem.error);

      showStatus(`Failed: ${nextItem.error}`, 'error');
      queueNotification('Failed', nextItem.displayName);
    } else {
      // eagle.log.info('Download cancelled:', nextItem.url);
    }
  } finally {
    cleanupTempFiles(nextItem.tempFiles);
  }

  state.activeProcesses.delete(nextItem.id);
  updateQueueUI();
  const finalActive = getActiveDownloadCount();
  updateIndicator(finalActive > 0 ? `Downloading ${finalActive}` : 'Ready', finalActive > 0 ? 'info' : 'success');

  setTimeout(processNextDownload, 300);
}

function cleanupTempFiles(files) {
  if (!files || !Array.isArray(files)) return;

  files.forEach(f => {
    try {
      if (f && fs.existsSync(f)) {
        fs.unlinkSync(f);
        // eagle.log.info('Cleaned up temp file:', path.basename(f));
      }
    } catch (e) {
      // eagle.log.warn('Failed to cleanup temp file:', f, e.message);
    }
  });
}

function updateQueueUI() {
  const queueList = document.getElementById('queueList');
  const queueCount = document.getElementById('queueCount');
  const queueSection = document.getElementById('queueSection');
  const queueEmptyBranding = document.getElementById('queueEmptyBranding');

  const activeCount = state.downloadQueue.filter(i => i.status === 'pending' || i.status === 'downloading').length;
  queueCount.textContent = activeCount;

  // Always show queue section, toggle branding based on empty state
  queueSection.classList.add('show');

  if (state.downloadQueue.length === 0) {
    queueList.innerHTML = '';
    if (queueEmptyBranding) {
      queueEmptyBranding.classList.add('show');
    }
    return;
  }

  if (queueEmptyBranding) {
    queueEmptyBranding.classList.remove('show');
  }

  let html = '';
  state.downloadQueue.forEach(item => {
    const statusClass = item.status;
    let icon = '\u23f8';
    let statusText = 'Pending';

    if (item.status === 'downloading') {
      icon = '\u2b07';
      statusText = item.progress > 0 ? `${item.progress}%` : 'Starting...';
    } else if (item.status === 'completed') {
      icon = '\u2713';
      statusText = 'Done';
    } else if (item.status === 'error' || item.status === 'cancelled') {
      icon = '\u2715';
      statusText = item.error || 'Failed';
    }

    const displayName = item.displayName || item.name;
    const shortName = displayName.length > 40 ? displayName.substring(0, 40) + '...' : displayName;

    // Get thumbnail URL (preview or custom thumbnail) - show for ALL states except error/cancelled
    const thumbnailUrl = item.thumbnailPreview || item.thumbnailUrl || null;
    const showThumbnail = thumbnailUrl && item.status !== 'error' && item.status !== 'cancelled';

    html += `
      <div class="queue-item ${statusClass}" title="${escapeHtml(displayName)}">
        ${showThumbnail ? `<img class="queue-thumbnail" src="${escapeHtml(thumbnailUrl)}" alt="${escapeHtml(displayName)}" onerror="this.style.display='none';">` : ''}
        <div class="queue-icon">${icon}</div>
        <div class="queue-info">
          <div class="queue-name">${escapeHtml(shortName)}</div>
          <div class="queue-status">
            <span class="queue-status-dot"></span>
            <span class="queue-status-text">${escapeHtml(statusText)}</span>
          </div>
        </div>
        <div class="queue-progress">
          <div class="queue-progress-fill" style="width: ${item.status === 'downloading' ? item.progress : (item.status === 'completed' ? 100 : 0)}%"></div>
        </div>
        <div class="queue-actions">
          ${item.status === 'downloading' || item.status === 'pending' ? `
            <button class="queue-action cancel" onclick="cancelDownload('${item.id}')" title="Cancel">\u2715</button>
          ` : item.status === 'error' || item.status === 'cancelled' ? `
            <button class="queue-action retry" onclick="retryDownload('${item.id}')" title="Retry">\u21bb</button>
          ` : `
            <button class="queue-action" onclick="removeFromQueue('${item.id}')" title="Remove">\u2715</button>
          `}
        </div>
      </div>
    `;
  });

  queueList.innerHTML = html;

  // Save queue state after UI update (status may have changed)
  saveQueue();
}

// Lightweight progress update - only updates progress bar without re-rendering
function updateProgressOnly(itemId, progress) {
  const queueItems = document.querySelectorAll('.queue-item');
  const item = state.downloadQueue.find(i => i.id === itemId);
  if (!item) return;

  const index = state.downloadQueue.indexOf(item);
  if (index >= 0 && queueItems[index]) {
    const progressFill = queueItems[index].querySelector('.queue-progress-fill');
    const statusText = queueItems[index].querySelector('.queue-status-text');
    if (progressFill) {
      progressFill.style.width = progress + '%';
    }
    if (statusText && item.status === 'downloading') {
      statusText.textContent = progress > 0 ? progress + '%' : 'Starting...';
    }
  }
}

function queueNotification(title, body) {
  if (!settings.notifications) return;
  pendingNotifications.push({ title, body });
  processNotificationQueue();
}

function processNotificationQueue() {
  if (!pendingNotifications.length) return;

  const now = Date.now();
  if (now - lastNotificationTime < NOTIFICATION_DELAY) {
    setTimeout(processNotificationQueue, NOTIFICATION_DELAY - (now - lastNotificationTime));
    return;
  }

  const n = pendingNotifications.shift();
  lastNotificationTime = now;
  eagle.notification.show({ title: n.title, body: n.body, mute: false, duration: 3000 }).catch(() => {});

  if (pendingNotifications.length) setTimeout(processNotificationQueue, NOTIFICATION_DELAY);
}

function cancelDownload(itemId, force = false) {
  const item = state.downloadQueue.find(i => i.id === parseFloat(itemId));
  if (!item) return;

  if (item.status === 'downloading') {
    if (!force) {
      showCancelConfirmDialog(item, itemId);
      return;
    }
    const proc = state.activeProcesses.get(item.id);
    if (proc) {
      state.activeProcesses.delete(item.id);
      killProcess(proc);
    }
    item.status = 'cancelled';
    item.error = 'Cancelled';
    setTimeout(() => cleanupTempFiles(item.tempFiles), 2500);
    setTimeout(processNextDownload, 100);
  } else if (item.status === 'pending') {
    item.status = 'cancelled';
    item.error = 'Cancelled';
  }

  updateQueueUI();
}

function showCancelConfirmDialog(item, itemId) {
  const existing = document.getElementById('cancelConfirmOverlay');
  if (existing) existing.remove();

  const displayName = item.displayName || item.name || 'this download';
  const safeName = escapeHtml(displayName.length > 60 ? displayName.substring(0, 60) + '...' : displayName);

  const overlay = document.createElement('div');
  overlay.id = 'cancelConfirmOverlay';
  overlay.className = 'modal-overlay show';
  overlay.innerHTML = `
    <div class="modal-content cancel-confirm-modal">
      <div class="modal-header">
        <h3>Cancel this download?</h3>
      </div>
      <div class="modal-body">
        <p class="cancel-confirm-name">"${safeName}"</p>
        <p class="cancel-confirm-sub">This will stop the download and delete any partial files.</p>
      </div>
      <div class="modal-actions">
        <button type="button" class="modal-btn secondary" id="cancelConfirmKeep">Keep Downloading</button>
        <button type="button" class="modal-btn warning" id="cancelConfirmStop">Cancel Download</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  document.getElementById('cancelConfirmKeep').addEventListener('click', () => {
    overlay.remove();
  });

  document.getElementById('cancelConfirmStop').addEventListener('click', () => {
    overlay.remove();
    cancelDownload(itemId, true);
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

function retryDownload(itemId) {
  const item = state.downloadQueue.find(i => i.id === parseFloat(itemId));
  if (!item || !['error', 'cancelled'].includes(item.status)) return;

  item.status = 'pending';
  item.progress = 0;
  item.error = null;
  item.tempFiles = [];

  saveQueue();
  updateQueueUI();
  processNextDownload();
}

function removeFromQueue(itemId) {
  const filtered = state.downloadQueue.filter(i => i.id !== parseFloat(itemId));
  state.downloadQueue.length = 0;
  state.downloadQueue.push(...filtered);
  saveQueue();
  updateQueueUI();
}

function clearCompleted() {
  const filtered = state.downloadQueue.filter(i => i.status === 'downloading' || i.status === 'pending');
  state.downloadQueue.length = 0;
  state.downloadQueue.push(...filtered);
  saveQueue();
  updateQueueUI();
}

window.cancelDownload = cancelDownload;
window.retryDownload = retryDownload;
window.removeFromQueue = removeFromQueue;

function updateIndicator(message, type = 'success') {
  try {
    const el = document.getElementById('notifier');
    if (el) {
      el.textContent = message;
      el.className = `notifier ${type}`;
    }
  } catch (e) {
    // eagle.log.warn('updateIndicator failed:', e.message);
  }
}

function showStatus(message, type = 'info') {
  try {
    const el = document.getElementById('status');
    if (el) {
      el.textContent = message;
      el.className = `status ${type} show`;
      setTimeout(() => {
        el.classList.remove('show');
      }, 4000);
    }
  } catch (e) {
    // eagle.log.warn('showStatus failed:', e.message);
  }
}

// Minimum window sizes for modals (max 700x700 per manifest)
const MODAL_MIN_SIZES = {
  help: { width: 450, height: 550 },
  install: { width: 500, height: 600 },
  legal: { width: 650, height: 700 }
};

// Track open modals for proper stacking and scroll lock
let openModals = [];

// Store original window size per modal type (for proper nested modal handling)
let modalWindowSizes = {};

// Add body scroll lock
function lockBodyScroll() {
  document.body.classList.add('modal-open');
}

// Remove body scroll lock (only if no modals open)
function unlockBodyScroll() {
  if (openModals.length === 0) {
    document.body.classList.remove('modal-open');
  }
}

// Register modal as open
function registerModalOpen(modalName) {
  if (!openModals.includes(modalName)) {
    openModals.push(modalName);
  }
  lockBodyScroll();
}

// Register modal as closed
function registerModalClose(modalName) {
  const index = openModals.indexOf(modalName);
  if (index > -1) {
    openModals.splice(index, 1);
  }
  unlockBodyScroll();
}

// Store original window size to restore later (legacy support)
let originalWindowSize = null;

// Store original min size to restore when install modal closes
let originalMinSize = null;

// Lock window minimum size for install modal
async function lockMinSizeForInstall() {
  try {
    if (eagle.window && eagle.window.setMinimumSize) {
      // Store current min size (from manifest: 200x450)
      originalMinSize = { width: 200, height: 450 };
      // Set temporary minimum size for install modal
      await eagle.window.setMinimumSize(350, 500);
    }
  } catch (e) {
    // API might not be available
  }
}

// Restore original minimum size
async function unlockMinSize() {
  try {
    if (eagle.window && eagle.window.setMinimumSize && originalMinSize) {
      await eagle.window.setMinimumSize(originalMinSize.width, originalMinSize.height);
      originalMinSize = null;
    }
  } catch (e) {
    // API might not be available
  }
}

// Expand window if needed for modal, returns true if expanded
async function expandWindowForModal(modalType) {
  const minSize = MODAL_MIN_SIZES[modalType];
  if (!minSize) return false;

  try {
    const currentSize = eagle.window.getSize();

    // Store size before this modal opens (for proper nested restoration)
    if (!modalWindowSizes[modalType]) {
      modalWindowSizes[modalType] = { width: currentSize.width, height: currentSize.height };
    }

    // Also keep legacy originalWindowSize for first modal only
    if (!originalWindowSize) {
      originalWindowSize = { width: currentSize.width, height: currentSize.height };
    }

    const needsExpand = currentSize.width < minSize.width || currentSize.height < minSize.height;
    if (needsExpand) {
      const newWidth = Math.max(currentSize.width, minSize.width);
      const newHeight = Math.max(currentSize.height, minSize.height);

      // Set the new size
      eagle.window.setSize(newWidth, newHeight);

      // Center window after resize for better UX
      try {
        eagle.window.center();
      } catch (e) {}

      eagle.log.info(`Window expanded to ${newWidth}x${newHeight} for ${modalType} modal`);
      return true;
    }
  } catch (e) {
    eagle.log.warn('Could not expand window:', e.message);
  }
  return false;
}

// Restore window to original size (only when all modals closed)
function restoreWindowSize(modalType) {
  // Remove size tracking for this modal
  if (modalType && modalWindowSizes[modalType]) {
    delete modalWindowSizes[modalType];
  }

  // Only restore if no other modals are open that needed expansion
  const hasOtherModals = Object.keys(modalWindowSizes).length > 0;

  if (!hasOtherModals && originalWindowSize) {
    try {
      eagle.window.setSize(originalWindowSize.width, originalWindowSize.height);
      eagle.window.center();
    } catch (e) {}
    originalWindowSize = null;
  }
}

// Show help tutorial modal (with optional auto-show for first run)
function showHelpTutorial(isFirstRun = false) {
  expandWindowForModal('help');
  registerModalOpen('help');

  const modal = document.getElementById('helpModal');
  modal.classList.add('show');

  const closeHelp = () => {
    modal.classList.remove('show');
    registerModalClose('help');
    restoreWindowSize('help');

    if (isFirstRun) {
      settings.tutorialShown = true;
      saveSettings();
    }
  };

  // Setup close handlers
  const closeBtn = document.getElementById('closeHelpBtn');
  const gotItBtn = document.getElementById('helpGotItBtn');

  const handleClose = () => {
    closeHelp();
    closeBtn.removeEventListener('click', handleClose);
    gotItBtn.removeEventListener('click', handleClose);
  };

  closeBtn.addEventListener('click', handleClose);
  gotItBtn.addEventListener('click', handleClose);

  // Close on overlay click
  modal.onclick = (e) => {
    if (e.target === modal) {
      handleClose();
    }
  };
}

function showConfirmation(title, message, detail, onConfirm) {
  const modal = document.getElementById('confirmationModal');
  const titleEl = document.getElementById('confirmationTitle');
  const messageEl = document.getElementById('confirmationMessage');
  const detailEl = document.getElementById('confirmationDetail');
  const cancelBtn = document.getElementById('confirmationCancelBtn');
  const confirmBtn = document.getElementById('confirmationConfirmBtn');

  titleEl.textContent = title;
  messageEl.textContent = message;
  detailEl.textContent = detail || '';
  detailEl.style.display = detail ? 'block' : 'none';

  registerModalOpen('confirmation');
  modal.classList.add('show');

  const closeModal = () => {
    modal.classList.remove('show');
    registerModalClose('confirmation');
    cancelBtn.removeEventListener('click', handleCancel);
    confirmBtn.removeEventListener('click', handleConfirm);
  };
  
  const handleCancel = () => {
    closeModal();
  };
  
  const handleConfirm = () => {
    closeModal();
    if (onConfirm) onConfirm();
  };
  
  cancelBtn.addEventListener('click', handleCancel);
  confirmBtn.addEventListener('click', handleConfirm);
}

async function showLegalDisclaimer() {
  expandWindowForModal('legal');
  registerModalOpen('legal');

  const modal = document.getElementById('legalModal');
  const acceptBtn = document.getElementById('legalAcceptBtn');
  const declineBtn = document.getElementById('legalDeclineBtn');

  modal.classList.add('show');

  const handleAccept = async () => {
    modal.classList.remove('show');
    registerModalClose('legal');
    restoreWindowSize('legal');
    settings.legalAccepted = true;
    saveSettings();

    // Reset container scroll to top
    const container = document.querySelector('.container');
    if (container) {
      container.scrollTop = 0;
    }

    // Continue plugin initialization
    await initializePlugin();

    // Show tutorial on first run (after legal accept and plugin init)
    if (!settings.tutorialShown) {
      setTimeout(() => {
        showHelpTutorial(true);
      }, 300);
    }

    acceptBtn.removeEventListener('click', handleAccept);
    declineBtn.removeEventListener('click', handleDecline);
  };

  const handleDecline = async () => {
    modal.classList.remove('show');
    registerModalClose('legal');
    restoreWindowSize('legal');
    try { if (typeof eagle.window.hide === 'function') await eagle.window.hide(); } catch (e) {}
    window.close(); // Close plugin if user declines
    acceptBtn.removeEventListener('click', handleAccept);
    declineBtn.removeEventListener('click', handleDecline);
  };

  acceptBtn.addEventListener('click', handleAccept);
  declineBtn.addEventListener('click', handleDecline);
}
