// ============================================================================
// DEPENDENCY AUTO-INSTALLER
// Version: 3.1.0
// ============================================================================

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn, execSync } = require('child_process');

const state = require('./state');

let callbacks = {};

function init(cb) {
  callbacks = cb;
}

// Download URLs for dependencies
const DEPENDENCY_URLS = {
  ytdlp: {
    win32: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
    darwin: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
    linux: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'
  },
  ffmpeg: {
    win32: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
    darwin: 'https://evermeet.cx/ffmpeg/getrelease/zip',
    linux: null // Use package manager on Linux
  },
  deno: {
    win32: 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip',
    darwin: 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-apple-darwin.zip',
    darwin_arm64: 'https://github.com/denoland/deno/releases/latest/download/deno-aarch64-apple-darwin.zip',
    linux: 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip'
  }
};

const DENO_MIN_VERSION = [2, 0, 0];

// Returns Eagle's shared binary directory (persists across plugin reinstalls)
async function getSharedBinDir() {
  const userData = await eagle.app.getPath('userData');
  const dir = path.join(userData, 'shared-bin');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Silent background Deno update — does not block plugin startup
async function updateDeno() {
  try {
    const sharedBinDir = await getSharedBinDir();
    const platform = process.platform;
    const arch = process.arch;
    const denoExe = platform === 'win32' ? 'deno.exe' : 'deno';
    const destPath = path.join(sharedBinDir, denoExe);

    let url = DEPENDENCY_URLS.deno[platform];
    if (platform === 'darwin' && arch === 'arm64') {
      url = DEPENDENCY_URLS.deno.darwin_arm64;
    }
    if (!url) return;

    const _tempDir = await eagle.app.getPath('temp');
    const zipPath = path.join(_tempDir, `deno_update_${Date.now()}.zip`);
    const extractDir = path.join(_tempDir, `deno_upd_extract_${Date.now()}`);

    eagle.log.info('Deno auto-update: downloading from ' + url);
    await downloadFileWithProgress(url, zipPath, () => {});

    if (!fs.existsSync(extractDir)) fs.mkdirSync(extractDir, { recursive: true });

    if (platform === 'win32') {
      try {
        execSync(`tar -xf "${zipPath}" -C "${extractDir}"`, { timeout: 60000, windowsHide: true });
      } catch {
        execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`, { timeout: 60000, windowsHide: true });
      }
    } else {
      execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { timeout: 60000 });
    }

    const extractedDeno = path.join(extractDir, denoExe);
    if (!fs.existsSync(extractedDeno)) throw new Error('Deno executable not found in archive');

    // Write to temp location first to avoid EBUSY if binary is in use
    const tmpDest = destPath + '.tmp';
    fs.copyFileSync(extractedDeno, tmpDest);
    try {
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
    } catch { /* file in use — leave old version */ }
    fs.renameSync(tmpDest, destPath);

    if (platform !== 'win32') fs.chmodSync(destPath, '755');

    state.resolvedDenoPath = destPath;
    eagle.log.info('Deno auto-updated successfully at: ' + destPath);

    // Cleanup
    try { fs.unlinkSync(zipPath); } catch {}
    try { fs.rmSync(extractDir, { recursive: true }); } catch {}
  } catch (e) {
    eagle.log.warn('Deno auto-update failed: ' + e.message);
  }
}

// Check what dependencies are missing
async function checkDependencies() {
  const platform = process.platform;
  const missing = {
    ytdlp: true,
    ffmpeg: true,
    deno: true
  };
  const ytdlpExe = platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const ffmpegExe = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const denoExe = platform === 'win32' ? 'deno.exe' : 'deno';

  // Eagle userData/shared-bin is the plugin-wide managed binary location.
  // It keeps upload folders lean and avoids one copy of large tools per plugin.
  let sharedBinDir = null;
  try {
    sharedBinDir = await getSharedBinDir();
  } catch(e) {
    eagle.log.warn('Could not resolve shared-bin dir: ' + e.message);
  }

  // Check yt-dlp - use same paths as checkYtDlp() for consistency
  const ytdlpPaths = [
    sharedBinDir ? path.join(sharedBinDir, ytdlpExe) : null,
    path.join(__dirname, '..', 'yt-dlp.exe'),
    path.join(__dirname, '..', 'Bin', 'yt-dlp.exe'),
    path.join(process.env.USERPROFILE || '', 'scoop', 'shims', 'yt-dlp.exe'),
    path.join(process.env.USERPROFILE || '', 'scoop', 'apps', 'yt-dlp', 'current', 'yt-dlp.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'yt-dlp.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages', 'yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe', 'yt-dlp.exe'),
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin', 'yt-dlp.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'Scripts', 'yt-dlp.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'Scripts', 'yt-dlp.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python310', 'Scripts', 'yt-dlp.exe'),
    path.join(__dirname, '..', 'yt-dlp'),
    path.join(__dirname, '..', 'yt-dlp_macos'),
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    '/opt/homebrew/bin/yt-dlp'
  ].filter(Boolean);

  for (const testPath of ytdlpPaths) {
    try {
      if (fs.existsSync(testPath)) {
        const result = execSync(`"${testPath}" --version`, { timeout: 10000, encoding: 'utf8', windowsHide: true });
        if (result && result.trim()) {
          missing.ytdlp = false;
          state.ytDlpPath = testPath;
          // eagle.log.info('Found yt-dlp at:', testPath);
          break;
        }
      }
    } catch(e) {}
  }

  // Also check PATH
  if (missing.ytdlp) {
    try {
      const result = execSync('yt-dlp --version', { timeout: 10000, encoding: 'utf8', windowsHide: true });
      if (result && result.trim()) {
        missing.ytdlp = false;
        state.ytDlpPath = 'yt-dlp';
        // eagle.log.info('Found yt-dlp in PATH');
      }
    } catch(e) {}
  }

  // Check FFmpeg - prioritize Eagle's built-in FFmpeg first
  try {
    const ffmpeg = eagle.extraModule.ffmpeg;
    eagle.log.info('Checking Eagle FFmpeg module...');
    if (ffmpeg && await ffmpeg.isInstalled()) {
      const paths = await ffmpeg.getPaths();
      eagle.log.info('Eagle FFmpeg paths: ' + JSON.stringify(paths));
      if (paths && paths.ffmpeg) {
        missing.ffmpeg = false;
        state.resolvedFfmpegPath = paths.ffmpeg;
        eagle.log.info('Eagle FFmpeg available at: ' + paths.ffmpeg);
      }
    } else {
      eagle.log.warn('Eagle FFmpeg not installed or not available');
    }
  } catch(e) {
    eagle.log.warn('Eagle FFmpeg check error: ' + e.message);
    // Eagle FFmpeg not available, will check local installations
  }

  // Check local FFmpeg installations if Eagle's FFmpeg not found
  if (missing.ffmpeg) {
    const ffmpegPaths = [
      sharedBinDir ? path.join(sharedBinDir, ffmpegExe) : null,
      path.join(__dirname, '..', 'ffmpeg.exe'),
      path.join(__dirname, '..', 'ffmpeg'),
      path.join(__dirname, '..', 'Bin', 'ffmpeg.exe'),
      path.join(__dirname, '..', 'Bin', 'ffmpeg')
    ].filter(Boolean);

    for (const testPath of ffmpegPaths) {
      try {
        if (fs.existsSync(testPath)) {
          const result = execSync(`"${testPath}" -version`, { timeout: 10000, encoding: 'utf8', windowsHide: true });
          if (result && result.includes('ffmpeg')) {
            missing.ffmpeg = false;
            state.resolvedFfmpegPath = testPath;
            // eagle.log.info('Found local FFmpeg at:', testPath);
            break;
          }
        }
      } catch(e) {}
    }
  }

  // Also check system PATH
  if (missing.ffmpeg) {
    try {
      const result = execSync('ffmpeg -version', { timeout: 10000, encoding: 'utf8', windowsHide: true });
      if (result && result.includes('ffmpeg')) {
        missing.ffmpeg = false;
        state.resolvedFfmpegPath = 'ffmpeg';
        // eagle.log.info('Found FFmpeg in system PATH');
      }
    } catch(e) {}
  }

  // Check Deno - required for YouTube downloads
  // Search order: shared-bin → system install → legacy plugin folder
  const denoPaths = [
    sharedBinDir ? path.join(sharedBinDir, denoExe) : null,
    path.join(process.env.USERPROFILE || '', '.deno', 'bin', denoExe),
    path.join(process.env.HOME || '', '.deno', 'bin', denoExe),
    '/usr/local/bin/deno',
    '/usr/bin/deno',
    '/opt/homebrew/bin/deno',
    // Legacy plugin folder locations (checked last for migration)
    path.join(__dirname, '..', denoExe),
    path.join(__dirname, '..', 'Bin', denoExe)
  ].filter(Boolean);

  for (const testPath of denoPaths) {
    try {
      if (fs.existsSync(testPath)) {
        const result = execSync(`"${testPath}" --version`, { timeout: 10000, encoding: 'utf8', windowsHide: true });
        if (result && result.includes('deno')) {
          missing.deno = false;
          state.resolvedDenoPath = testPath;
          eagle.log.info('Found Deno at: ' + testPath);

          // Migrate from legacy plugin folder to shared-bin
          const pluginDir = path.resolve(__dirname, '..');
          const isLegacy = testPath.startsWith(pluginDir) && sharedBinDir;
          if (isLegacy) {
            const sharedDest = path.join(sharedBinDir, denoExe);
            try {
              fs.copyFileSync(testPath, sharedDest);
              try { fs.unlinkSync(testPath); } catch(e) { /* EBUSY — skip delete, next run will find shared */ }
              state.resolvedDenoPath = sharedDest;
              eagle.log.info('Migrated Deno from plugin folder to shared-bin: ' + sharedDest);
            } catch(e) {
              eagle.log.warn('Deno migration failed (using legacy path): ' + e.message);
            }
          }

          break;
        }
      }
    } catch(e) {}
  }

  // Also check system PATH for Deno
  if (missing.deno) {
    try {
      const result = execSync('deno --version', { timeout: 10000, encoding: 'utf8', windowsHide: true });
      if (result && result.includes('deno')) {
        missing.deno = false;
        state.resolvedDenoPath = 'deno';
        eagle.log.info('Found Deno in system PATH');
      }
    } catch(e) {}
  }

  // Version check — trigger silent auto-update if below minimum
  if (state.resolvedDenoPath) {
    try {
      const verOut = execSync(`"${state.resolvedDenoPath}" --version`, { timeout: 5000, encoding: 'utf8', windowsHide: true });
      const match = verOut.match(/deno (\d+)\.(\d+)\.(\d+)/);
      if (match) {
        const ver = [parseInt(match[1]), parseInt(match[2]), parseInt(match[3])];
        const [maj, min, patch] = DENO_MIN_VERSION;
        const isOk = ver[0] > maj ||
                     (ver[0] === maj && ver[1] > min) ||
                     (ver[0] === maj && ver[1] === min && ver[2] >= patch);
        if (!isOk) {
          eagle.log.warn(`Deno ${ver.join('.')} below minimum ${DENO_MIN_VERSION.join('.')}, triggering silent update`);
          updateDeno().catch(e => eagle.log.warn('Deno auto-update failed: ' + e.message));
        } else {
          eagle.log.info(`Deno ${ver.join('.')} meets minimum requirement`);
        }
      }
    } catch(e) {
      eagle.log.warn('Deno version check failed: ' + e.message);
    }
  }

  return missing;
}

// Show the installation modal
function showInstallModal(missing) {
  callbacks.expandWindowForModal('install');
  callbacks.registerModalOpen('install');
  callbacks.lockMinSizeForInstall();

  const modal = document.getElementById('installModal');
  if (!modal) {
    // eagle.log.error('Install modal not found in DOM');
    callbacks.registerModalClose('install');
    return;
  }

  // Update status indicators based on what's missing
  const ytdlpStatus = document.getElementById('ytdlpStatus');
  const ffmpegStatus = document.getElementById('ffmpegStatus');

  if (!missing.ytdlp) {
    ytdlpStatus.innerHTML = '<span class="status-completed"><svg class="status-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> Installed</span>';
    document.getElementById('installItemYtdlp').classList.add('completed');
  }

  if (!missing.ffmpeg) {
    ffmpegStatus.innerHTML = '<span class="status-completed"><svg class="status-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> Installed</span>';
    document.getElementById('installItemFfmpeg').classList.add('completed');
  }

  // Update Deno status
  const denoStatus = document.getElementById('denoStatus');
  const denoItem = document.getElementById('installItemDeno');
  if (denoStatus && denoItem) {
    if (!missing.deno) {
      denoStatus.innerHTML = '<span class="status-completed"><svg class="status-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> Installed</span>';
      denoItem.classList.add('completed');
    }
  }

  // If nothing is missing, don't show modal
  if (!missing.ytdlp && !missing.ffmpeg && !missing.deno) {
    // eagle.log.info('All dependencies installed, skipping install modal');
    callbacks.registerModalClose('install');
    return false;
  }

  // Calculate total download size based on what's missing
  let totalSize = 0;
  if (missing.ytdlp) totalSize += 18; // ~18 MB
  if (missing.ffmpeg) totalSize += 200; // ~200 MB
  if (missing.deno) totalSize += 118; // ~118 MB

  const sizeText = document.getElementById('installSizeText');
  if (sizeText) {
    sizeText.textContent = `Total download: ~${totalSize} MB (one-time setup)`;
  }

  // Show appropriate action buttons based on what's missing
  const installActions = document.getElementById('installActions');
  const ffmpegActions = document.getElementById('installFfmpegActions');

  if (missing.ffmpeg && !missing.ytdlp && !missing.deno) {
    // Only FFmpeg missing - show recommendation to use Eagle's FFmpeg
    installActions.style.display = 'none';
    ffmpegActions.style.display = 'flex';
  } else {
    // yt-dlp missing (with or without FFmpeg) - show normal install button
    installActions.style.display = 'flex';
    ffmpegActions.style.display = 'none';
  }

  modal.classList.add('show');

  // Setup event listeners
  setupInstallModalListeners(missing);

  return true;
}

function hideInstallModal() {
  const modal = document.getElementById('installModal');
  if (modal) modal.classList.remove('show');
  callbacks.registerModalClose('install');
  callbacks.restoreWindowSize('install');
  callbacks.unlockMinSize();
}

// Setup install modal event listeners
function setupInstallModalListeners(missing) {
  const startBtn = document.getElementById('installStartBtn');
  const doneBtn = document.getElementById('installDoneBtn');
  const manualLink = document.getElementById('manualInstallLink');
  const cancelBtn = document.getElementById('installCancelBtn');
  const installAnywayBtn = document.getElementById('installAnywayBtn');

  const handleStart = async () => {
    startBtn.disabled = true;
    startBtn.innerHTML = '<span class="status-spinner"></span> Installing...';

    try {
      await runInstallation(missing);
    } catch (err) {
      eagle.log.error('Installation failed: ' + (err.message || err));
      showInstallError(err.message || 'Installation failed');
      startBtn.disabled = false;
      startBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg> Retry Installation';
    }
  };

  const handleDone = async () => {
    hideInstallModal();
    // Continue to legal modal
    if (!state.settings.legalAccepted) {
      callbacks.showLegalDisclaimer();
    } else {
      await callbacks.initializePlugin();
    }
  };

  const handleManualLink = (e) => {
    e.preventDefault();
    eagle.shell.openExternal('https://github.com/yt-dlp/yt-dlp#installation');
  };

  const handleCancel = () => {
    hideInstallModal();
    // Plugin won't work without dependencies, but let user decide
  };

  const handleInstallAnyway = async () => {
    installAnywayBtn.disabled = true;
    installAnywayBtn.innerHTML = '<span class="status-spinner"></span> Installing...';

    try {
      // Hide FFmpeg actions, show progress
      document.getElementById('installFfmpegActions').style.display = 'none';
      await runInstallation(missing);
    } catch (err) {
      eagle.log.error('Installation failed: ' + (err.message || err));
      showInstallError(err.message || 'Installation failed');
      document.getElementById('installFfmpegActions').style.display = 'flex';
      installAnywayBtn.disabled = false;
      installAnywayBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg> Install Anyway';
    }
  };

  // Remove old listeners and add new ones
  if (startBtn) startBtn.onclick = handleStart;
  if (doneBtn) doneBtn.onclick = handleDone;
  if (manualLink) manualLink.onclick = handleManualLink;
  if (cancelBtn) cancelBtn.onclick = handleCancel;
  if (installAnywayBtn) installAnywayBtn.onclick = handleInstallAnyway;
}

// Run the actual installation
async function runInstallation(missing) {
  const progressSection = document.getElementById('installProgress');
  const sizeInfo = document.getElementById('installSizeInfo');

  progressSection.style.display = 'block';
  sizeInfo.style.display = 'none';

  try {
    // Install yt-dlp first (smaller, faster)
    if (missing.ytdlp) {
      await installYtDlp();
    }

    // Install Deno (required for YouTube)
    if (missing.deno) {
      await installDeno();
    }

    // Then install FFmpeg
    if (missing.ffmpeg) {
      await installFFmpeg();
    }

    // Verify installation
    await verifyInstallation();

    // Show success
    showInstallSuccess();

  } catch (err) {
    throw err;
  }
}

// Download file with progress
function downloadFileWithProgress(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    // eagle.log.info('Downloading:', url);
    // eagle.log.info('Destination:', destPath);

    const protocol = url.startsWith('https') ? https : http;

    const request = protocol.get(url, {
      timeout: 120000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    }, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307) {
        const redirectUrl = response.headers.location;
        // eagle.log.info('Following redirect to:', redirectUrl);
        downloadFileWithProgress(redirectUrl, destPath, onProgress)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${response.statusCode}`));
        return;
      }

      const totalSize = parseInt(response.headers['content-length'], 10) || 0;
      let downloadedSize = 0;

      const file = fs.createWriteStream(destPath);

      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        file.write(chunk);

        if (totalSize > 0 && onProgress) {
          const percent = Math.round((downloadedSize / totalSize) * 100);
          const downloadedMB = (downloadedSize / 1024 / 1024).toFixed(1);
          const totalMB = (totalSize / 1024 / 1024).toFixed(1);
          onProgress(percent, `${downloadedMB} MB / ${totalMB} MB`);
        }
      });

      response.on('end', () => {
        file.end();
        // eagle.log.info('Download complete:', destPath);
        resolve(destPath);
      });

      response.on('error', (err) => {
        file.close();
        try { fs.unlinkSync(destPath); } catch(e) {}
        reject(err);
      });
    });

    request.on('timeout', () => {
      request.destroy();
      try { fs.unlinkSync(destPath); } catch(e) {}
      reject(new Error('Download timeout'));
    });

    request.on('error', (err) => {
      try { fs.unlinkSync(destPath); } catch(e) {}
      reject(err);
    });
  });
}

// Install yt-dlp
async function installYtDlp() {
  const platform = process.platform;
  const url = DEPENDENCY_URLS.ytdlp[platform];

  if (!url) {
    throw new Error(`yt-dlp download not available for ${platform}`);
  }

  updateInstallStatus('ytdlp', 'installing', 'Downloading...');
  updateInstallProgress('Downloading yt-dlp...', 0, '');

  // Determine destination filename
  const filename = platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const sharedBinDir = await getSharedBinDir();
  const destPath = path.join(sharedBinDir, filename);

  try {
    await downloadFileWithProgress(url, destPath, (percent, detail) => {
      updateInstallProgress('Downloading yt-dlp...', percent, detail);
    });

    // Make executable on Unix systems
    if (platform !== 'win32') {
      fs.chmodSync(destPath, '755');
    }

    // Verify it works with retry logic (Windows file locking issue)
    updateInstallProgress('Verifying yt-dlp...', 95, 'checking installation');
    let result;

    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        result = execSync(`"${destPath}" --version`, { timeout: 10000, encoding: 'utf8', windowsHide: true });
        if (result && result.trim()) {
          break; // Success!
        }
      } catch (err) {
        eagle.log.warn(`Verification attempt ${attempt}/5 failed:`, err.message);

        // If file is locked, wait and retry
        if (err.message.includes('being used by another process') ||
            err.message.includes('EBUSY') ||
            err.message.includes('EPERM')) {

          if (attempt < 5) {
            const delay = attempt * 1000; // 1s, 2s, 3s, 4s
            eagle.log.info(`File locked, waiting ${delay}ms before retry...`);
            updateInstallProgress('Waiting for file access...', 95, `retry ${attempt}/5`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        }
        throw err; // Other errors or max retries reached
      }
    }

    if (!result || !result.trim()) {
      throw new Error('yt-dlp verification failed after retries');
    }

    state.ytDlpPath = destPath;
    updateInstallStatus('ytdlp', 'completed', 'Installed');
    eagle.log.info('yt-dlp installed successfully');

  } catch (err) {
    updateInstallStatus('ytdlp', 'failed', 'Failed');
    throw new Error(`yt-dlp installation failed: ${err.message}`);
  }
}

// Install Deno (required for YouTube downloads)
async function installDeno() {
  const platform = process.platform;
  const arch = process.arch;

  // Select correct URL based on platform and architecture
  let url = DEPENDENCY_URLS.deno[platform];
  if (platform === 'darwin' && arch === 'arm64') {
    url = DEPENDENCY_URLS.deno.darwin_arm64;
  }

  if (!url) {
    throw new Error(`Deno download not available for ${platform}`);
  }

  updateInstallStatus('deno', 'installing', 'Downloading...');
  updateInstallProgress('Downloading Deno...', 0, 'Required for YouTube');

  const zipPath = path.join(state.tempDir, `deno_${Date.now()}.zip`);
  const denoExe = platform === 'win32' ? 'deno.exe' : 'deno';
  // Install to shared-bin so Deno survives plugin reinstalls
  const sharedBinDir = await getSharedBinDir();
  const destPath = path.join(sharedBinDir, denoExe);

  try {
    await downloadFileWithProgress(url, zipPath, (percent, detail) => {
      updateInstallProgress('Downloading Deno...', percent, detail);
    });

    updateInstallProgress('Extracting Deno...', 90, 'Please wait...');

    // Extract the zip - Deno zip contains just the executable
    const extractDir = path.join(state.tempDir, `deno_extract_${Date.now()}`);
    if (!fs.existsSync(extractDir)) {
      fs.mkdirSync(extractDir, { recursive: true });
    }

    if (platform === 'win32') {
      // Try tar first (Windows 10+)
      try {
        execSync(`tar -xf "${zipPath}" -C "${extractDir}"`, { timeout: 60000, windowsHide: true });
      } catch (tarErr) {
        // Fallback to PowerShell
        execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`, { timeout: 60000, windowsHide: true });
      }
    } else {
      execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { timeout: 60000 });
    }

    // Find and move the deno executable
    const extractedDeno = path.join(extractDir, denoExe);
    if (fs.existsSync(extractedDeno)) {
      fs.copyFileSync(extractedDeno, destPath);
    } else {
      throw new Error('Deno executable not found in archive');
    }

    // Make executable on Unix
    if (platform !== 'win32') {
      fs.chmodSync(destPath, '755');
    }

    // Cleanup
    try { fs.unlinkSync(zipPath); } catch(e) {}
    try { fs.rmSync(extractDir, { recursive: true }); } catch(e) {}

    // Verify installation
    updateInstallProgress('Verifying Deno...', 95, 'checking installation');

    let result;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        result = execSync(`"${destPath}" --version`, { timeout: 10000, encoding: 'utf8', windowsHide: true });
        if (result && result.includes('deno')) {
          break;
        }
      } catch (err) {
        if (attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        throw err;
      }
    }

    if (!result || !result.includes('deno')) {
      throw new Error('Deno verification failed');
    }

    state.resolvedDenoPath = destPath;
    updateInstallStatus('deno', 'completed', 'Installed');
    eagle.log.info('Deno installed successfully at: ' + destPath);

  } catch (err) {
    updateInstallStatus('deno', 'failed', 'Failed');
    // Cleanup on failure
    try { fs.unlinkSync(zipPath); } catch(e) {}
    throw new Error(`Deno installation failed: ${err.message}`);
  }
}

// Install FFmpeg
async function installFFmpeg() {
  const platform = process.platform;
  const url = DEPENDENCY_URLS.ffmpeg[platform];

  if (!url) {
    // On Linux, suggest package manager
    if (platform === 'linux') {
      updateInstallStatus('ffmpeg', 'failed', 'Use apt/dnf');
      // eagle.log.warn('FFmpeg should be installed via package manager on Linux');
      return; // Don't throw, just skip
    }
    throw new Error(`FFmpeg download not available for ${platform}`);
  }

  updateInstallStatus('ffmpeg', 'installing', 'Downloading...');
  updateInstallProgress('Downloading FFmpeg...', 0, 'This may take a minute...');

  const zipPath = path.join(state.tempDir, `ffmpeg_${Date.now()}.zip`);

  try {
    await downloadFileWithProgress(url, zipPath, (percent, detail) => {
      updateInstallProgress('Downloading FFmpeg...', percent, detail);
    });

    updateInstallProgress('Extracting FFmpeg...', 0, 'Please wait...');

    // Extract the zip
    await extractFFmpegZip(zipPath, platform);

    // Cleanup zip file
    try { fs.unlinkSync(zipPath); } catch(e) {}

    updateInstallStatus('ffmpeg', 'completed', 'Installed');
    eagle.log.info('FFmpeg installed successfully');

  } catch (err) {
    try { fs.unlinkSync(zipPath); } catch(e) {}
    updateInstallStatus('ffmpeg', 'failed', 'Failed');
    throw new Error(`FFmpeg installation failed: ${err.message}`);
  }
}

// Extract FFmpeg zip file
async function extractFFmpegZip(zipPath, platform) {
  const extractDir = path.join(state.tempDir, `ffmpeg_extract_${Date.now()}`);
  const sharedBinDir = await getSharedBinDir();

  try {
    // Create extraction directory
    if (!fs.existsSync(extractDir)) {
      fs.mkdirSync(extractDir, { recursive: true });
    }

    // eagle.log.info('Starting extraction...');
    // eagle.log.info('ZIP path:', zipPath);
    // eagle.log.info('Extract to:', extractDir);

    if (!fs.existsSync(zipPath)) {
      throw new Error('ZIP file does not exist: ' + zipPath);
    }

    const zipSize = fs.statSync(zipPath).size;
    // eagle.log.info('ZIP file size:', zipSize, 'bytes', '(' + Math.round(zipSize / 1024 / 1024) + ' MB)');

    if (zipSize < 1000000) { // Less than 1 MB
      eagle.log.error('ZIP file is suspiciously small! Expected ~200 MB, got ' + Math.round(zipSize / 1024 / 1024) + ' MB');
      throw new Error('Downloaded ZIP file is incomplete or corrupted (too small)');
    }

    if (platform === 'win32') {
      // Try tar first (built into Windows 10+, much better for large files)
      try {
        const tarCmd = `tar -xf "${zipPath}" -C "${extractDir}"`;
        // eagle.log.info('Extracting with tar (Windows 10+ built-in):', tarCmd);
        execSync(tarCmd, { timeout: 300000, windowsHide: true, encoding: 'utf8' });
        // eagle.log.info('Tar extraction output:', output || '(success - no output)');
      } catch (tarErr) {
        // eagle.log.warn('Tar extraction failed, trying PowerShell:', tarErr.message);

        // Fallback to PowerShell
        const cmd = `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`;
        // eagle.log.info('Extracting with PowerShell:', cmd);

        try {
          execSync(cmd, { timeout: 300000, windowsHide: true, encoding: 'utf8' });
          // eagle.log.info('PowerShell extraction output:', output || '(no output)');
        } catch (err) {
          eagle.log.error('PowerShell extraction also failed: ' + err.message);
          // eagle.log.error('stderr:', err.stderr ? err.stderr.toString() : 'N/A');
          // eagle.log.error('stdout:', err.stdout ? err.stdout.toString() : 'N/A');
          throw new Error('Both tar and PowerShell extraction failed. The ZIP file may be corrupted.');
        }
      }
    } else {
      // Use unzip on macOS/Linux
      try {
        execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { timeout: 300000, encoding: 'utf8' });
        // eagle.log.info('Unzip output:', output);
      } catch (err) {
        eagle.log.error('Unzip failed: ' + err.message);
        throw err;
      }
    }

    // eagle.log.info('Extraction completed, checking directory contents...');

    // Find ffmpeg and ffprobe in extracted files
    const ffmpegExe = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const ffprobeExe = platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';

    // eagle.log.info('Searching for FFmpeg executables in:', extractDir);
    // eagle.log.info('Looking for:', ffmpegExe, 'and', ffprobeExe);

    // List all files in extract directory for debugging
    // try {
    //   const listAllFiles = (dir, depth = 0) => {
    //     if (depth > 3) return; // Limit recursion depth
    //     const files = fs.readdirSync(dir);
    //     files.forEach(file => {
    //       const fullPath = path.join(dir, file);
    //       const stat = fs.statSync(fullPath);
    //       eagle.log.info(`  ${'  '.repeat(depth)}${stat.isDirectory() ? '[DIR]' : '[FILE]'} ${file}`);
    //       if (stat.isDirectory() && depth < 3) {
    //         listAllFiles(fullPath, depth + 1);
    //       }
    //     });
    //   };
    //   listAllFiles(extractDir);
    // } catch(e) {
    //   eagle.log.warn('Could not list extracted files:', e.message);
    // }

    let ffmpegPath = findFileRecursive(extractDir, ffmpegExe);
    let ffprobePath = findFileRecursive(extractDir, ffprobeExe);

    // eagle.log.info('Search complete - Found ffmpeg at:', ffmpegPath || 'NOT FOUND');
    // eagle.log.info('Search complete - Found ffprobe at:', ffprobePath || 'NOT FOUND');

    if (!ffmpegPath) {
      // Try to find any .exe files to help diagnose
      eagle.log.error('FFmpeg executable not found! Searching for ANY .exe files...');
      const allExeFiles = [];
      const findAllExe = (dir, depth = 0) => {
        if (depth > 10) return;
        try {
          const files = fs.readdirSync(dir);
          files.forEach(file => {
            const fullPath = path.join(dir, file);
            try {
              const stat = fs.statSync(fullPath);
              if (stat.isDirectory()) {
                findAllExe(fullPath, depth + 1);
              } else if (file.toLowerCase().endsWith('.exe')) {
                allExeFiles.push(fullPath);
                // eagle.log.info(`  Found .exe: ${fullPath}`);
              }
            } catch(e) {}
          });
        } catch(e) {}
      };
      findAllExe(extractDir);

      // Check if we found ffmpeg.exe in the list but search missed it
      const ffmpegInList = allExeFiles.find(p => p.toLowerCase().includes('ffmpeg.exe'));
      const ffprobeInList = allExeFiles.find(p => p.toLowerCase().includes('ffprobe.exe'));

      if (ffmpegInList) {
        // eagle.log.warn('Found ffmpeg.exe in .exe list but search missed it!');
        // eagle.log.warn('Using path from .exe search:', ffmpegInList);
        ffmpegPath = ffmpegInList;
        if (ffprobeInList) {
          ffprobePath = ffprobeInList;
        }
      } else {
        throw new Error(`ffmpeg executable not found in archive. Extract dir: ${extractDir}. Found ${allExeFiles.length} .exe files total.`);
      }
    }

    // Copy to shared managed binary directory instead of the plugin folder.
    const destFfmpeg = path.join(sharedBinDir, ffmpegExe);
    const destFfprobe = path.join(sharedBinDir, ffprobeExe);

    fs.copyFileSync(ffmpegPath, destFfmpeg);
    // eagle.log.info('Copied ffmpeg to:', destFfmpeg);

    if (ffprobePath) {
      fs.copyFileSync(ffprobePath, destFfprobe);
      // eagle.log.info('Copied ffprobe to:', destFfprobe);
    }

    // Make executable on Unix
    if (platform !== 'win32') {
      fs.chmodSync(destFfmpeg, '755');
      if (fs.existsSync(destFfprobe)) {
        fs.chmodSync(destFfprobe, '755');
      }
    }

    // Verify ffmpeg works with retry logic (Windows file locking issue)
    updateInstallProgress('Verifying FFmpeg...', 95, 'checking installation');
    let result;

    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        result = execSync(`"${destFfmpeg}" -version`, { timeout: 10000, encoding: 'utf8', windowsHide: true });
        if (result && result.trim()) {
          break; // Success!
        }
      } catch (err) {
        // eagle.log.warn(`FFmpeg verification attempt ${attempt}/5 failed:`, err.message);

        // If file is locked, wait and retry
        if (err.message.includes('being used by another process') ||
            err.message.includes('EBUSY') ||
            err.message.includes('EPERM')) {

          if (attempt < 5) {
            const delay = attempt * 1000; // 1s, 2s, 3s, 4s
            // eagle.log.info(`FFmpeg file locked, waiting ${delay}ms before retry...`);
            updateInstallProgress('Waiting for file access...', 95, `retry ${attempt}/5`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        }
        throw err; // Other errors or max retries reached
      }
    }

    if (!result || !result.trim()) {
      throw new Error('FFmpeg verification failed after retries');
    }
    state.resolvedFfmpegPath = destFfmpeg;

    // eagle.log.info('FFmpeg verified successfully');

    // Cleanup extraction directory
    try {
      fs.rmSync(extractDir, { recursive: true, force: true });
    } catch(e) {
      // eagle.log.warn('Could not cleanup extraction dir:', e.message);
    }

  } catch (err) {
    // DON'T cleanup on error - keep the directory so user can inspect it
    eagle.log.error('Extraction failed, keeping directory for inspection: ' + extractDir);
    // eagle.log.error('Opening directory in file explorer...');

    // Open the directory in file explorer for user to inspect
    try {
      if (process.platform === 'win32') {
        require('child_process').exec(`explorer "${extractDir}"`);
      } else if (process.platform === 'darwin') {
        require('child_process').exec(`open "${extractDir}"`);
      }
    } catch(e) {
      // eagle.log.warn('Could not open directory:', e.message);
    }

    throw err;
  }
}

// Recursively find a file in a directory
function findFileRecursive(dir, filename, depth = 0) {
  try {
    if (depth > 10) {
      // eagle.log.warn('Max recursion depth reached at:', dir);
      return null;
    }

    const files = fs.readdirSync(dir);
    const lowerFilename = filename.toLowerCase();

    // eagle.log.info(`  ${'  '.repeat(depth)}Searching in: ${dir} (${files.length} items)`);

    for (const file of files) {
      const fullPath = path.join(dir, file);
      let stat;

      try {
        stat = fs.statSync(fullPath);
      } catch(e) {
        // eagle.log.warn(`  ${'  '.repeat(depth)}Cannot stat: ${fullPath} - ${e.message}`);
        continue;
      }

      if (stat.isDirectory()) {
        const found = findFileRecursive(fullPath, filename, depth + 1);
        if (found) return found;
      } else if (file.toLowerCase() === lowerFilename) {
        // eagle.log.info(`  ${'  '.repeat(depth)}FOUND MATCH: ${fullPath}`);
        return fullPath;
      }
    }
  } catch(e) {
    // eagle.log.warn(`Error in findFileRecursive at ${dir}:`, e.message);
  }
  return null;
}

// Verify installation worked
async function verifyInstallation() {
  updateInstallProgress('Verifying installation...', 90, '');

  // Re-check dependencies
  const missing = await checkDependencies();

  if (missing.ytdlp) {
    throw new Error('yt-dlp installation could not be verified');
  }

  // FFmpeg is optional, don't fail if missing
  // if (missing.ffmpeg) {
  //   eagle.log.warn('FFmpeg installation could not be verified, but continuing...');
  // }

  updateInstallProgress('Installation complete!', 100, '');
}

// UI update helpers
function updateInstallStatus(dep, statusType, text) {
  const statusEl = document.getElementById(`${dep}Status`);
  const itemEl = document.getElementById(`installItem${dep.charAt(0).toUpperCase() + dep.slice(1)}`);

  if (!statusEl || !itemEl) return;

  // Remove old state classes
  itemEl.classList.remove('installing', 'completed', 'failed');

  switch (statusType) {
    case 'installing':
      itemEl.classList.add('installing');
      statusEl.innerHTML = `<span class="status-installing"><span class="status-spinner"></span> ${text}</span>`;
      break;
    case 'completed':
      itemEl.classList.add('completed');
      statusEl.innerHTML = `<span class="status-completed"><svg class="status-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> ${text}</span>`;
      break;
    case 'failed':
      itemEl.classList.add('failed');
      statusEl.innerHTML = `<span class="status-failed">\u274C ${text}</span>`;
      break;
    default:
      statusEl.innerHTML = `<span class="status-pending">${text}</span>`;
  }
}

function updateInstallProgress(label, percent, detail) {
  const labelEl = document.getElementById('installProgressLabel');
  const barEl = document.getElementById('installProgressBar');
  const detailEl = document.getElementById('installProgressDetail');

  if (labelEl) labelEl.textContent = label;
  if (barEl) barEl.style.width = `${percent}%`;
  if (detailEl) detailEl.textContent = detail;
}

function showInstallError(message) {
  const errorEl = document.getElementById('installError');
  const messageEl = document.getElementById('installErrorMessage');
  const progressEl = document.getElementById('installProgress');

  if (progressEl) progressEl.style.display = 'none';
  if (messageEl) messageEl.textContent = message;
  if (errorEl) errorEl.style.display = 'block';
}

function showInstallSuccess() {
  const actionsEl = document.getElementById('installActions');
  const successActionsEl = document.getElementById('installSuccessActions');
  const progressEl = document.getElementById('installProgress');

  // Update progress to show complete
  updateInstallProgress('\u2713 All dependencies installed!', 100, 'Ready to download videos');

  // Swap action buttons
  if (actionsEl) actionsEl.style.display = 'none';
  if (successActionsEl) successActionsEl.style.display = 'flex';
}

// ============================================================================
// YT-DLP AUTO-UPDATE
// ============================================================================

function getYtDlpCurrentVersion() {
  if (!state.ytDlpPath) return null;
  try {
    return execSync(`"${state.ytDlpPath}" --version`, { timeout: 10000, encoding: 'utf8', windowsHide: true }).trim();
  } catch { return null; }
}

function fetchLatestYtDlpVersion() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/yt-dlp/yt-dlp/releases/latest',
      headers: { 'User-Agent': 'Eagle-Video-Downloader' }
    };
    const req = https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const tag = JSON.parse(data).tag_name;
          resolve(tag || null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

function normalizeVersionLabel(version) {
  return String(version || '').trim().replace(/^(stable@|v)/i, '');
}

function compareVersionLabels(a, b) {
  const left = normalizeVersionLabel(a).split(/[^0-9]+/).filter(Boolean).map(Number);
  const right = normalizeVersionLabel(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  const len = Math.max(left.length, right.length);

  for (let i = 0; i < len; i++) {
    const l = Number.isFinite(left[i]) ? left[i] : 0;
    const r = Number.isFinite(right[i]) ? right[i] : 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }

  return 0;
}

async function checkYtDlpUpdate(silent = true) {
  if (!state.ytDlpPath) return;

  const current = getYtDlpCurrentVersion();
  if (!current) return;

  const latest = await fetchLatestYtDlpVersion();
  if (!latest) {
    if (!silent) callbacks.updateIndicator('Update check failed', 'error');
    return;
  }

  const normalizedLatest = normalizeVersionLabel(latest);
  if (compareVersionLabels(current, latest) >= 0) {
    if (!silent) {
      callbacks.updateIndicator('yt-dlp is up to date', 'success');
      eagle.notification.show({ title: 'yt-dlp', body: `Already on latest (${current})`, mute: false, duration: 3000 }).catch(() => {});
    }
    eagle.log.info(`yt-dlp up to date: ${current}`);
    return;
  }

  eagle.log.info(`yt-dlp update available: ${current} \u2192 ${normalizedLatest}`);

  callbacks.showConfirmation(
    'yt-dlp Update Available',
    `Update from ${current} to ${normalizedLatest}?`,
    'Keeps YouTube downloads working. Takes a few seconds.',
    () => runYtDlpUpdate(current, normalizedLatest)
  );
}

function runYtDlpUpdate(oldVersion, newVersion) {
  callbacks.updateIndicator('Updating yt-dlp...', 'info');
  callbacks.showLoadingScreen('Updating yt-dlp...');

  // Update the settings button state if visible
  const btn = document.getElementById('updateYtDlpBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Updating...'; }

  const proc = spawn(state.ytDlpPath, ['-U'], {
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
  });

  let output = '';
  proc.stdout.on('data', d => output += d.toString());
  proc.stderr.on('data', d => output += d.toString());

  proc.on('close', (code) => {
    if (btn) { btn.disabled = false; btn.textContent = 'Check for Updates'; }
    callbacks.hideLoadingScreen();

    if (code === 0 && !output.toLowerCase().includes('error')) {
      const ver = getYtDlpCurrentVersion() || newVersion;
      eagle.log.info(`yt-dlp updated to ${ver}`);
      callbacks.updateIndicator('yt-dlp updated!', 'success');
      eagle.notification.show({
        title: 'yt-dlp Updated',
        body: `${oldVersion} \u2192 ${ver}`,
        mute: false,
        duration: 4000
      }).catch(() => {});
    } else {
      eagle.log.error('yt-dlp update failed: ' + output.slice(-500));
      callbacks.updateIndicator('Update failed', 'error');
      eagle.notification.show({
        title: 'yt-dlp Update Failed',
        body: 'Check Eagle console for details',
        mute: false,
        duration: 4000
      }).catch(() => {});
    }
  });

  proc.on('error', (err) => {
    if (btn) { btn.disabled = false; btn.textContent = 'Check for Updates'; }
    callbacks.hideLoadingScreen();
    eagle.log.error('yt-dlp update spawn error: ' + err.message);
    callbacks.updateIndicator('Update failed', 'error');
  });
}

function isPathInside(parentDir, candidatePath) {
  if (!parentDir || !candidatePath) return false;
  const parent = path.resolve(parentDir);
  const candidate = path.resolve(candidatePath);
  return candidate === parent || candidate.startsWith(parent + path.sep);
}

async function uninstallManagedDependencies() {
  const pluginDir = path.resolve(__dirname, '..');
  const platform = process.platform;
  const managed = new Set();

  const localBinaryNames = platform === 'win32'
    ? ['yt-dlp.exe', 'ffmpeg.exe', 'ffprobe.exe', 'deno.exe']
    : ['yt-dlp', 'yt-dlp_macos', 'ffmpeg', 'ffprobe', 'deno'];

  for (const name of localBinaryNames) {
    managed.add(path.join(pluginDir, name));
    managed.add(path.join(pluginDir, 'Bin', name));
  }

  let sharedBinDir = null;
  try {
    sharedBinDir = await getSharedBinDir();
  } catch (e) {
    eagle.log.warn('Could not resolve shared-bin dir for uninstall: ' + e.message);
  }

  if (sharedBinDir) {
    for (const name of localBinaryNames) {
      managed.add(path.join(sharedBinDir, name));
    }
  }

  // If current resolved paths point to plugin-managed locations, include them explicitly.
  const dynamicPaths = [state.ytDlpPath, state.resolvedFfmpegPath, state.resolvedDenoPath].filter(Boolean);
  dynamicPaths.forEach((candidate) => {
    if (!path.isAbsolute(candidate)) return;
    if (isPathInside(pluginDir, candidate) || (sharedBinDir && isPathInside(sharedBinDir, candidate))) {
      managed.add(candidate);
    }
  });

  let filesRemoved = 0;
  const removedPaths = [];

  for (const filePath of managed) {
    try {
      if (!filePath || !fs.existsSync(filePath)) continue;
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) continue;
      fs.unlinkSync(filePath);
      filesRemoved++;
      removedPaths.push(filePath);
    } catch (e) {
      eagle.log.warn('Could not remove managed dependency file: ' + filePath + ' (' + e.message + ')');
    }
  }

  if (state.ytDlpPath && removedPaths.includes(state.ytDlpPath)) {
    state.ytDlpPath = null;
  }
  if (state.resolvedFfmpegPath && removedPaths.includes(state.resolvedFfmpegPath)) {
    state.resolvedFfmpegPath = null;
  }
  if (state.resolvedDenoPath && removedPaths.includes(state.resolvedDenoPath)) {
    state.resolvedDenoPath = null;
  }

  return { filesRemoved, removedPaths };
}

module.exports = {
  init,
  DEPENDENCY_URLS,
  DENO_MIN_VERSION,
  getSharedBinDir,
  updateDeno,
  checkDependencies,
  showInstallModal,
  hideInstallModal,
  downloadFileWithProgress,
  checkYtDlpUpdate,
  runYtDlpUpdate,
  getYtDlpCurrentVersion,
  uninstallManagedDependencies,
};
