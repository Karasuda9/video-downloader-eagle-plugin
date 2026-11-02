const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn, execSync } = require('child_process');
const { StringDecoder } = require('string_decoder');

const state = require('./state');

let callbacks = {};

const HTTP_TIMEOUT = 120000; // 2 minutes socket timeout for direct HTTP downloads
const DOWNLOAD_INACTIVITY_TIMEOUT = 300000; // 5 minutes of no progress before timing out yt-dlp

function init(cb) {
  callbacks = cb;
}

function buildYtDlpEnv() {
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

function addJsRuntimeArgs(args) {
  if (state.resolvedDenoPath) {
    args.push('--js-runtimes', 'deno,node');
  }
}

async function resolveFfmpegPath() {
  try {
    const ffmpeg = eagle.extraModule && eagle.extraModule.ffmpeg;
    if (ffmpeg && await ffmpeg.isInstalled()) {
      const paths = await ffmpeg.getPaths();
      state.resolvedFfmpegPath = paths.ffmpeg;
      return paths.ffmpeg;
    }
  } catch {}

  const ffmpegExe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [state.resolvedFfmpegPath];
  try {
    const userData = await eagle.app.getPath('userData');
    candidates.push(path.join(userData, 'shared-bin', ffmpegExe));
  } catch {}
  candidates.push(path.join(__dirname, '..', ffmpegExe), path.join(__dirname, '..', 'Bin', ffmpegExe));

  for (const candidate of candidates.filter(Boolean)) {
    try {
      if (fs.existsSync(candidate)) {
        const result = execSync(`"${candidate}" -version`, { timeout: 10000, encoding: 'utf8', windowsHide: true });
        if (result && result.includes('ffmpeg')) {
          state.resolvedFfmpegPath = candidate;
          return candidate;
        }
      }
    } catch {}
  }

  try {
    const result = execSync('ffmpeg -version', { timeout: 10000, encoding: 'utf8', windowsHide: true });
    if (result && result.includes('ffmpeg')) {
      state.resolvedFfmpegPath = 'ffmpeg';
      return 'ffmpeg';
    }
  } catch {}
  return null;
}

// ============================================================================
// UNIFIED ERROR ANALYSIS
// Returns both user-friendly message and fix suggestion for any error
// ============================================================================
function analyzeError(err) {
  if (!err) return { message: 'Unknown error', fix: 'Try downloading again' };

  const msg = (err.message || String(err)).toLowerCase();

  // Network errors
  if (msg.includes('enotfound') || msg.includes('getaddrinfo')) {
    return { message: 'Network error - check connection', fix: '💡 Check your internet connection and try again' };
  }
  if (msg.includes('etimedout')) {
    return { message: 'Connection timed out - slow network?', fix: '💡 The download was too slow. Try: 1) Lower quality setting, 2) Check your network, 3) Try again later' };
  }
  if (msg.includes('stalled') || msg.includes('no progress')) {
    return { message: 'Download stalled - try again', fix: '💡 The download was too slow. Try: 1) Lower quality setting, 2) Check your network, 3) Try again later' };
  }
  if (msg.includes('timeout') && !msg.includes('stalled')) {
    return { message: 'Network timeout - check connection', fix: '💡 The download was too slow. Try: 1) Lower quality setting, 2) Check your network, 3) Try again later' };
  }
  if (msg.includes('econnrefused')) {
    return { message: 'Connection refused', fix: '💡 Check your internet connection and try again' };
  }
  if (msg.includes('econnreset')) {
    return { message: 'Connection reset', fix: '💡 Check your internet connection and try again' };
  }
  if (msg.includes('socket hang up')) {
    return { message: 'Connection dropped', fix: '💡 Check your internet connection and try again' };
  }

  // HTTP errors
  if (msg.includes('http 403') || msg.includes('forbidden')) {
    return { message: 'Access forbidden', fix: '💡 Access denied. Try enabling cookies in Settings, or the video may be restricted' };
  }
  if (msg.includes('http 404') || msg.includes('not found')) {
    return { message: 'Not found', fix: '💡 This video no longer exists or has been removed by the uploader' };
  }
  if (msg.includes('http 429') || msg.includes('too many')) {
    return { message: 'Rate limited - wait and retry', fix: '💡 Too many requests. Wait 10-15 minutes before trying again' };
  }
  if (msg.includes('http 5')) {
    return { message: 'Server error - try later', fix: '💡 Server is having issues. Try again in a few minutes' };
  }

  // Video-specific errors
  if (msg.includes('private') || msg.includes('sign in')) {
    return { message: 'Video is private', fix: '💡 This video is private. You need the owner to make it public or unlisted' };
  }
  if (msg.includes('age') || msg.includes('confirm your age')) {
    return { message: 'Age-restricted', fix: '💡 Enable cookies in Settings → Authentication. Export cookies from your browser while logged in' };
  }
  if (msg.includes('members') || msg.includes('subscriber')) {
    return { message: 'Members-only content', fix: '💡 This is members-only content. Enable cookies with a subscribed account' };
  }
  if (msg.includes('geo') || msg.includes('country') || msg.includes('not available in')) {
    return { message: 'Geo-restricted', fix: '💡 This video is blocked in your region. Try using a VPN' };
  }
  if (msg.includes('unavailable') || msg.includes('not available') || msg.includes('removed') || msg.includes('deleted')) {
    return { message: 'Video unavailable', fix: '💡 This video no longer exists or has been removed by the uploader' };
  }
  if (msg.includes('copyright') || msg.includes('blocked')) {
    return { message: 'Copyright blocked', fix: '💡 This video was removed due to copyright. Try finding an alternative source' };
  }
  if (msg.includes('live') && msg.includes('not')) {
    return { message: 'Live stream not supported', fix: '💡 Live streams cannot be downloaded. Wait until the stream ends and try the VOD' };
  }

  // Tool errors
  if (msg.includes('unsupported') || msg.includes('no suitable') || msg.includes('not supported')) {
    return { message: 'Site not supported', fix: '💡 This site may not be supported. Check yt-dlp supported sites list, or update yt-dlp' };
  }
  if (msg.includes('no video formats') || msg.includes('no formats')) {
    return { message: 'No formats available', fix: '💡 No downloadable formats found. The video may be DRM protected or require authentication' };
  }
  if (msg.includes('yt-dlp') || msg.includes('spawn')) {
    return { message: 'yt-dlp error', fix: '💡 Update yt-dlp to the latest version: run "yt-dlp -U" in terminal' };
  }
  if (msg.includes('ffmpeg')) {
    return { message: 'FFmpeg error', fix: '💡 Install or update FFmpeg for better format support' };
  }

  // File errors
  if (msg.includes('enoent') || msg.includes('file not found')) {
    return { message: 'File not found', fix: '💡 The file could not be found. Try downloading again' };
  }
  if (msg.includes('eacces') || msg.includes('permission')) {
    return { message: 'Permission denied', fix: '💡 Permission denied. Check that Eagle has write access to the temp folder' };
  }
  if (msg.includes('enospc') || msg.includes('disk full')) {
    return { message: 'Disk full', fix: '💡 Your disk is full. Free up some space and try again' };
  }
  if (msg.includes('empty')) {
    return { message: 'Empty file', fix: '💡 The downloaded file was empty. Try again' };
  }

  // Default fallback
  const cleanMsg = err.message || 'Download failed';
  const displayMsg = cleanMsg.length > 50 ? cleanMsg.substring(0, 47) + '...' : cleanMsg;
  return {
    message: displayMsg,
    fix: '💡 Try again. If it keeps failing, check if the URL is correct and the video is still available'
  };
}

// Backward compatibility: keep old function signatures as wrappers
function getDetailedErrorMessage(err) {
  return analyzeError(err).message;
}

function getFixSuggestion(errorMessage) {
  return analyzeError({ message: errorMessage }).fix;
}

async function downloadVideo(queueItem) {
  if (isDirectVideoUrl(queueItem.url)) {
    await downloadDirectVideo(queueItem);
  } else {
    if (!state.ytDlpPath && !await callbacks.checkYtDlp()) throw new Error('yt-dlp not installed');
    await downloadWithYtDlp(queueItem);
  }
}

function isDirectVideoUrl(url) {
  const exts = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.m4v', '.mp3', '.m4a', '.wav', '.ogg'];
  try {
    return exts.some(ext => new URL(url).pathname.toLowerCase().endsWith(ext));
  } catch {
    return false;
  }
}

async function downloadDirectVideo(queueItem) {
  const tempDir = await eagle.app.getPath('temp');
  const timestamp = Date.now();

  let filename = queueItem.name;
  if (!filename || filename === 'Fetching...') {
    try {
      filename = decodeURIComponent(path.basename(new URL(queueItem.url).pathname).replace(/\.[^/.]+$/, ""));
    } catch {
      filename = `video_${timestamp}`;
    }
  }

  queueItem.displayName = filename;
  callbacks.updateQueueUI();

  const ext = path.extname(new URL(queueItem.url).pathname) || '.mp4';
  const videoFilePath = path.join(tempDir, `eagle_video_${timestamp}${ext}`);
  queueItem.tempFiles.push(videoFilePath);

  await downloadFile(queueItem.url, videoFilePath, (progress) => {
    queueItem.progress = Math.round(progress * 90);
    callbacks.updateProgressOnly(queueItem.id, queueItem.progress);
  });

  if (!fs.existsSync(videoFilePath) || fs.statSync(videoFilePath).size === 0) {
    throw new Error('Download failed');
  }

  queueItem.progress = 95;
  callbacks.updateProgressOnly(queueItem.id, queueItem.progress);

  filename = filename.replace(/\.(mp4|webm|mkv|avi|mp3|m4a)$/i, '').trim();
  await addToEagle(videoFilePath, filename, queueItem.url, queueItem.folderIds, queueItem.tags, queueItem.annotation, queueItem.thumbnailUrl);
}

// ============================================================================
// HELPER: Find downloaded files from yt-dlp
// Returns { videoPath, thumbPath } or throws error if video not found
// ============================================================================
function findDownloadedFiles(tempDir, timestamp) {
  // eagle.log.info('Looking for files with pattern:', `eagle_ytdlp_${timestamp}`);
  // eagle.log.info('In temp directory:', tempDir);

  // const allTempFiles = fs.readdirSync(tempDir).filter(f => f.includes('eagle_'));
  // eagle.log.info('All eagle temp files:', allTempFiles.join(', '));

  // Find video file
  const videoFiles = fs.readdirSync(tempDir).filter(f =>
    f.startsWith(`eagle_ytdlp_${timestamp}`) && !f.match(/\.(jpg|webp|png)$/)
  );

  // eagle.log.info('Matching video files:', videoFiles.join(', ') || 'NONE FOUND');

  if (!videoFiles.length) {
    eagle.log.error('No video file found after download');
    throw new Error('Downloaded file not found');
  }

  const videoPath = path.join(tempDir, videoFiles[0]);
  // eagle.log.info('Video file path:', videoPath);

  // Validate video file
  if (!fs.existsSync(videoPath)) {
    eagle.log.error('Video file does not exist: ' + videoPath);
    throw new Error('Video file does not exist');
  }

  const fileStats = fs.statSync(videoPath);
  // eagle.log.info('Video file size:', fileStats.size, 'bytes');

  if (fileStats.size === 0) {
    eagle.log.error('Video file is empty');
    throw new Error('Downloaded file is empty');
  }

  // Find thumbnail file (optional)
  let thumbPath = null;
  const thumbFiles = fs.readdirSync(tempDir).filter(f =>
    f.startsWith(`eagle_ytdlp_${timestamp}`) && f.match(/\.(jpg|webp|png)$/)
  );
  if (thumbFiles.length) {
    thumbPath = path.join(tempDir, thumbFiles[0]);
    // eagle.log.info('Found thumbnail:', thumbPath);
  }

  return { videoPath, thumbPath };
}

async function downloadWithYtDlp(queueItem) {
  let videoUrl = queueItem.url;

  try {
    const urlObj = new URL(videoUrl);
    ['list', 'start_radio', 'si'].forEach(p => urlObj.searchParams.delete(p));
    videoUrl = urlObj.toString();
  } catch(e) {}

  const tempDir = await eagle.app.getPath('temp');
  const timestamp = Date.now();
  const isAudioOnly = queueItem.format === 'mp3';
  const outputFile = path.join(tempDir, `eagle_ytdlp_${timestamp}.%(ext)s`);
  // Register the stem so every file yt-dlp writes (.part, .ytdl, .fNNN, fragments,
  // thumbnails) is swept on success, failure, stall or cancel, not just the final output.
  queueItem.tempFiles.push(path.join(tempDir, `eagle_ytdlp_${timestamp}`));

  const ffmpegPath = await resolveFfmpegPath();

  let formatString;
  if (isAudioOnly) {
    formatString = 'bestaudio/best';
  } else {
    const q = queueItem.quality;
    if (q === '1080p') formatString = 'bestvideo[height<=1080]+bestaudio/best[height<=1080]';
    else if (q === '720p') formatString = 'bestvideo[height<=720]+bestaudio/best[height<=720]';
    else if (q === '480p') formatString = 'bestvideo[height<=480]+bestaudio/best[height<=480]';
    else formatString = 'bestvideo+bestaudio/best';
  }

  // Deno is required for YouTube JS extractors — block only YouTube URLs if missing
  if (!state.resolvedDenoPath) {
    try {
      const urlObj = new URL(videoUrl);
      const host = urlObj.hostname;
      const isYouTube = host.includes('youtube.com') || host.includes('youtu.be') || host.includes('music.youtube.com');
      if (isYouTube) {
        throw new Error('Deno is required for YouTube downloads. Install it from the dependency wizard (Settings > Install Dependencies).');
      }
    } catch(e) {
      if (e.message && e.message.includes('Deno is required')) throw e;
      // URL parse failed — not YouTube, proceed
    }
  }

  return new Promise((resolve, reject) => {
    let inactivityTimeout = null;
    let lastActivityTime = Date.now();

    // Reset inactivity timeout whenever there's activity
    function resetInactivityTimeout() {
      lastActivityTime = Date.now();
      if (inactivityTimeout) clearTimeout(inactivityTimeout);
      inactivityTimeout = setTimeout(() => {
        const inactiveSeconds = Math.round((Date.now() - lastActivityTime) / 1000);
        eagle.log.error('Download timed out after ' + inactiveSeconds + 's of no progress');
        const proc = state.activeProcesses.get(queueItem.id);
        if (proc) {
          // Delete from map FIRST (before kill) to prevent double-kill race
          state.activeProcesses.delete(queueItem.id);
          callbacks.killProcess(proc);
        }
        // Reject with specific 'stalled' marker for auto-requeue logic
        reject(new Error('stalled'));
      }, DOWNLOAD_INACTIVITY_TIMEOUT);
    }

    // Start the initial timeout
    resetInactivityTimeout();

    // Fetch title if needed, then start download
    fetchVideoTitle(videoUrl, queueItem).then(() => {
      startDownload();
    });

    // Clean title fetching - retry once, then fallback
    async function fetchVideoTitle(url, item) {
      // Skip if we already have a valid title from preview or user input
      if (item.name && item.name !== 'Fetching...' && item.name !== 'NA' && item.name.length > 0) {
        eagle.log.info('Using existing title: ' + item.name);
        // Set displayName to match to avoid any inconsistency
        item.displayName = item.name;
        return;
      }

      eagle.log.info('Fetching video title for: ' + url);

      const maxAttempts = 2;
      let lastError = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const title = await new Promise((resolve, reject) => {
            // Build args array for spawn (more reliable than exec for paths with spaces)
            const args = [
              '--no-playlist',
              '--dump-single-json',
              '--skip-download',
              '--encoding', 'utf-8',
              '--no-colors',
              '--no-warnings',
              '--extractor-retries', '3',
              '--file-access-retries', '3',
              '--retries', '3',
              '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            ];

            // Add cookies if enabled
            if (state.settings.useCookies && state.settings.cookiesPath && fs.existsSync(state.settings.cookiesPath)) {
              args.push('--cookies', state.settings.cookiesPath);
            }

            addJsRuntimeArgs(args);

            args.push(url);

            const decoder = new StringDecoder('utf8');
            const stderrDecoder = new StringDecoder('utf8');
            let stdout = '';
            let stderr = '';

            const proc = spawn(state.ytDlpPath, args, {
              windowsHide: true,
              env: buildYtDlpEnv()
            });

            const procKey = `title-${Date.now()}`;
            state.activeProcesses.set(procKey, proc);

            const timeout = setTimeout(() => {
              state.activeProcesses.delete(procKey);
              callbacks.killProcess(proc);
              reject(new Error('Title fetch timeout'));
            }, 30000);

            proc.stdout.on('data', (data) => { stdout += decoder.write(data); });
            proc.stderr.on('data', (data) => { stderr += stderrDecoder.write(data); });

            proc.on('close', (code) => {
              clearTimeout(timeout);
              state.activeProcesses.delete(procKey);
              stdout += decoder.end();
              stderr += stderrDecoder.end();

              const stdoutLines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
              const stderrLines = stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
              const firstLine = stdoutLines[0] || '';
              const stderrTail = (stderrLines[stderrLines.length - 1] || '').slice(0, 240);

              if (code !== 0) {
                const reason = stderrTail || `yt-dlp exited with code ${code}`;
                reject(new Error(reason));
                return;
              }

              let extractedTitle = '';

              const parseJsonTitle = (text) => {
                if (!text) return '';
                try {
                  const json = JSON.parse(text);
                  const candidate = (json?.title || json?.fulltitle || json?.id || '').toString().trim();
                  return candidate && candidate !== 'NA' && candidate !== 'null' ? candidate : '';
                } catch {
                  return '';
                }
              };

              extractedTitle = parseJsonTitle(stdout.trim());
              if (!extractedTitle) {
                for (const line of stdoutLines) {
                  extractedTitle = parseJsonTitle(line);
                  if (extractedTitle) break;
                }
              }

              if (!extractedTitle && firstLine && firstLine !== 'NA' && firstLine !== 'null') {
                extractedTitle = firstLine;
              }

              if (extractedTitle) {
                resolve(extractedTitle);
              } else {
                reject(new Error(stderrTail || 'Invalid or empty title metadata'));
              }
            });

            proc.on('error', (err) => {
              clearTimeout(timeout);
              state.activeProcesses.delete(procKey);
              reject(err);
            });
          });

          // Success
          item.displayName = title;
          item.name = title;
          eagle.log.info('Got video title from yt-dlp: ' + title);
          callbacks.updateQueueUI();
          return;
        } catch (err) {
          const message = err && err.message ? err.message : String(err);
          lastError = new Error(message);
          eagle.log.warn(`Title fetch attempt ${attempt}/${maxAttempts} failed: ${message}`);

          if (attempt < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, attempt * 500));
          }
        }
      }

      const finalMessage = lastError?.message || 'Unknown title fetch error';
      eagle.log.warn('Title fetch failed after retries: ' + finalMessage);

      // Fallback: use URL-based name
      const fallbackName = generateFallbackName(url);
      item.displayName = fallbackName;
      item.name = fallbackName;
      callbacks.updateQueueUI();

      // Notify user
      eagle.notification.show({
        title: 'Could not get video title',
        body: `Using "${fallbackName}" - URL saved to history`,
        mute: false,
        duration: 4000
      }).catch(() => {});

      callbacks.showStatus('Using fallback name', 'warning');
    }

    // Generate a clean fallback name from URL
    function generateFallbackName(url) {
      try {
        const urlObj = new URL(url);
        const host = urlObj.hostname.replace('www.', '');

        // Try to extract video ID from common patterns
        if (host.includes('youtube') || host.includes('youtu.be')) {
          const videoId = urlObj.searchParams.get('v') || urlObj.pathname.split('/').pop();
          if (videoId && videoId.length === 11) {
            return `YouTube_${videoId}`;
          }
        }

        if (host.includes('vimeo')) {
          const videoId = urlObj.pathname.split('/').filter(Boolean).pop();
          if (videoId && /^\d+$/.test(videoId)) {
            return `Vimeo_${videoId}`;
          }
        }

        // Generic: use hostname + timestamp
        const shortHost = host.split('.')[0];
        return `${shortHost}_${Date.now().toString(36)}`;
      } catch {
        return `Video_${Date.now().toString(36)}`;
      }
    }

    function startDownload() {
      // eagle.log.info('Starting yt-dlp download for:', videoUrl);
      // eagle.log.info('Using yt-dlp path:', state.ytDlpPath);
      // eagle.log.info('Format:', formatString);
      // eagle.log.info('Output template:', outputFile);

      // Build args array with anti-403 measures
      const args = [
        '--no-playlist',
        '-f', formatString,
        '--no-mtime',
        '--newline',
        '--progress',
        '--no-colors',
        '--encoding', 'utf-8',
        '-o', outputFile,
        // Anti-bot detection measures
        '--extractor-retries', '3',
        '--file-access-retries', '3',
        '--fragment-retries', '10',
        '--retries', '10',
        '--retry-sleep', 'fragment:exp=1:8',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ];

      // Add cookies if enabled and file exists
      if (state.settings.useCookies && state.settings.cookiesPath) {
        if (fs.existsSync(state.settings.cookiesPath)) {
          args.push('--cookies', state.settings.cookiesPath);
          // eagle.log.info('Using cookies file:', state.settings.cookiesPath);
        } else {
          // eagle.log.warn('Cookies file not found:', state.settings.cookiesPath);
        }
      }

      // Speed flags: skip for audio-only (MP3 files are small, no DASH/HLS)
      if (!isAudioOnly) {
        args.push('--throttled-rate', '100K');
        args.push('--concurrent-fragments', String(callbacks.getConcurrentFragments()));
      }

      // Add format-specific args
      if (isAudioOnly) {
        args.push('-x', '--audio-format', 'mp3');
      } else {
        args.push('--merge-output-format', 'mp4');
      }

      // Add ffmpeg path if available
      if (ffmpegPath) {
        args.push('--ffmpeg-location', ffmpegPath);
        eagle.log.info('Added --ffmpeg-location: ' + ffmpegPath);
      } else {
        eagle.log.warn('No FFmpeg path available - some features may not work');
      }

      // Explicit Deno runtime — required for YouTube JS extractors
      addJsRuntimeArgs(args);

      // Add thumbnail and URL (URL always last)
      args.push('--write-thumbnail', videoUrl);

      eagle.log.info('Starting yt-dlp with ' + args.length + ' args for: ' + videoUrl);

      const ytdlp = spawn(state.ytDlpPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildYtDlpEnv()
      });
      state.activeProcesses.set(queueItem.id, ytdlp);

      // Use StringDecoder to properly handle UTF-8 characters split across chunks
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      let allOutput = '';

      const processOutput = (output) => {
        allOutput += output;

        // Reset inactivity timeout on any output (shows yt-dlp is working)
        resetInactivityTimeout();

        // Parse download progress - yt-dlp format: [download]  45.2% of 123.45MiB at 1.23MiB/s ETA 00:12
        const progressMatch = output.match(/\[download\]\s+(\d+\.?\d*)%/);
        if (progressMatch) {
          const percent = parseFloat(progressMatch[1]);
          if (!isNaN(percent) && percent >= 0 && percent <= 100) {
            // Use full range 0-100 for download, reserve last 5% for post-processing
            const newProgress = Math.min(95, Math.round(percent * 0.95));
            const currentProgress = queueItem.progress || 0;
            // Only update if progress increases - prevents backward jumps when
            // yt-dlp downloads multiple streams (video then audio) and resets percentage
            if (newProgress >= currentProgress) {
              queueItem.progress = newProgress;
              callbacks.updateProgressOnly(queueItem.id, queueItem.progress);
            }
          }
        }

        // Check for post-processing stages
        if (output.includes('[Merger]') || output.includes('[ExtractAudio]') || output.includes('[ffmpeg]')) {
          queueItem.progress = 96;
          callbacks.updateProgressOnly(queueItem.id, queueItem.progress);
        }
      };

      ytdlp.stdout.on('data', (data) => processOutput(stdoutDecoder.write(data)));
      ytdlp.stderr.on('data', (data) => processOutput(stderrDecoder.write(data)));

      ytdlp.on('error', (err) => {
        if (inactivityTimeout) clearTimeout(inactivityTimeout);
        state.activeProcesses.delete(queueItem.id);
        reject(new Error(`yt-dlp error: ${err.message}`));
      });

      ytdlp.on('close', async (code) => {
        if (inactivityTimeout) clearTimeout(inactivityTimeout);
        state.activeProcesses.delete(queueItem.id);

        // Flush any remaining bytes from decoders
        allOutput += stdoutDecoder.end();
        allOutput += stderrDecoder.end();

        if (code !== 0) {
          eagle.log.error('yt-dlp failed with code: ' + code);
          // Log output for debugging
          eagle.log.error('yt-dlp output (last 2000 chars): ' + allOutput.slice(-2000));

          if (code === null || queueItem.status === 'cancelled') return reject(new Error('cancelled'));

          const lower = allOutput.toLowerCase();

          // Check for specific error patterns
          if (lower.includes('private') || lower.includes('sign in')) return reject(new Error('Video is private or requires sign-in'));
          if (lower.includes('unavailable')) return reject(new Error('Video unavailable'));
          if (lower.includes('unsupported')) return reject(new Error('Site not supported by yt-dlp'));
          if (lower.includes('no video formats') || lower.includes('requested format not available')) return reject(new Error('No video formats available (may be DRM protected)'));
          if (lower.includes('403') || lower.includes('forbidden')) return reject(new Error('Access forbidden (403) - try enabling cookies'));
          if (lower.includes('age') && lower.includes('restrict')) return reject(new Error('Age-restricted video - enable cookies in settings'));
          if (lower.includes('geo') && lower.includes('block')) return reject(new Error('Video is geo-blocked in your region'));
          if (lower.includes('copyright')) return reject(new Error('Video blocked due to copyright'));
          if (lower.includes('members only') || lower.includes('member')) return reject(new Error('Members-only content - requires subscription'));
          if (lower.includes('live') && lower.includes('not started')) return reject(new Error('Live stream has not started yet'));
          if (lower.includes('premieres')) return reject(new Error('Video premiere has not started yet'));

          // Try to extract ERROR message from yt-dlp output
          const errorMatch = allOutput.match(/ERROR[:\s]+(.+?)[\n\r]/i);
          if (errorMatch) {
            const errorMsg = errorMatch[1].trim().substring(0, 200); // Limit length
            eagle.log.error('Extracted error: ' + errorMsg);
            return reject(new Error(errorMsg));
          }

          // Check for WARNING that might explain the issue
          const warningMatch = allOutput.match(/WARNING[:\s]+\[youtube\][^\n]*no supported javascript runtime[^\n]*/i);
          if (warningMatch) {
            eagle.log.warn('JS runtime warning detected but download should still work via HLS');
          }

          return reject(new Error('yt-dlp failed with code ' + code + ' - check Eagle console for details'));
        }

        queueItem.progress = 90;
        callbacks.updateQueueUI();

        try {
          // Find downloaded video and thumbnail files
          const { videoPath: videoFilePath, thumbPath } = findDownloadedFiles(tempDir, timestamp);
          queueItem.tempFiles.push(videoFilePath);
          if (thumbPath) queueItem.tempFiles.push(thumbPath);

          let filename = queueItem.name;
          // eagle.log.info('Determining filename - queueItem.name:', queueItem.name);
          // eagle.log.info('Determining filename - queueItem.displayName:', queueItem.displayName);

          if (!filename || filename === 'Fetching...' || filename === 'NA') {
            // Try displayName first, then fallback to file basename
            if (queueItem.displayName && queueItem.displayName !== 'Fetching...' && queueItem.displayName !== 'NA') {
              filename = queueItem.displayName;
              // eagle.log.info('Using displayName:', filename);
            } else {
              // Use file basename as last resort
              filename = path.basename(videoFilePath, path.extname(videoFilePath));
              // Clean up yt-dlp temp filename pattern
              filename = filename.replace(/^eagle_ytdlp_\d+/, 'video');
              // eagle.log.info('Using file basename:', filename);
            }
          }
          filename = filename.replace(/\.(mp4|webm|mkv|avi|mp3|m4a)$/i, '').replace(/[<>:"/\\|?*]/g, '').substring(0, 200).trim();

          // Final fallback if filename is still problematic
          if (!filename || filename === 'video') {
            filename = `Video_${timestamp}`;
            // eagle.log.warn('Using timestamp fallback filename:', filename);

            // Notify about fallback
            try {
              await eagle.notification.show({
                title: '⚠️ Using Fallback Name',
                body: `Could not get video title. Saved as "${filename}"`,
                mute: false,
                duration: 4000
              });
            } catch(e) {}
          }

          // eagle.log.info('Final filename:', filename);

          queueItem.displayName = filename;

          // Update thumbnail in queue if downloaded
          if (thumbPath && !queueItem.thumbnailPreview) {
            queueItem.thumbnailPreview = `file:///${thumbPath.replace(/\\/g, '/')}`;
          }

          callbacks.updateQueueUI();

          // CRITICAL: Check if cancelled before adding to Eagle
          if (queueItem.status === 'cancelled') {
            // eagle.log.info('Download was cancelled, skipping Eagle import');
            callbacks.cleanupTempFiles(queueItem.tempFiles);
            return reject(new Error('Cancelled'));
          }

          await addToEagle(videoFilePath, filename, videoUrl, queueItem.folderIds, queueItem.tags, queueItem.annotation, thumbPath || queueItem.thumbnailUrl);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    }
  });
}

async function addToEagle(videoFilePath, filename, sourceUrl, folderIds, tags, annotation, thumbnailPathOrUrl) {
  // eagle.log.info('Adding to Eagle: ' + filename);
  // eagle.log.info('File:', videoFilePath);
  // eagle.log.info('Folder IDs:', JSON.stringify(folderIds));
  // eagle.log.info('Tags:', JSON.stringify(tags));

  // Validate folder IDs
  if (folderIds && folderIds.length > 0) {
    // eagle.log.info('Validating folder ID:', folderIds[0]);
    try {
      await eagle.folder.getById(folderIds[0]);
      // eagle.log.info('Folder exists:', folder ? folder.name : 'NOT FOUND');
    } catch (e) {
      // eagle.log.error('Folder validation error:', e.message);
    }
  }

  const addOptions = {
    name: filename,
    website: sourceUrl,
    tags: tags || [],
    folders: folderIds || [],
    annotation: annotation || ''
  };

  // eagle.log.info('addFromPath options:', JSON.stringify(addOptions));

  const itemId = await eagle.item.addFromPath(videoFilePath, addOptions);

  // eagle.log.info('Successfully added to Eagle, item ID:', itemId);

  // Verify the item was added to the folder
  if (folderIds && folderIds.length > 0) {
    try {
      await eagle.item.getById(itemId);
      // eagle.log.info('Item folders after add:', JSON.stringify(item.folders));
    } catch (e) {
      // eagle.log.error('Could not verify item folders:', e.message);
    }
  }

  if (thumbnailPathOrUrl) {
    try {
      let thumbPath = thumbnailPathOrUrl;

      if (!fs.existsSync(thumbnailPathOrUrl) && callbacks.isValidUrl(thumbnailPathOrUrl)) {
        const tempDir = await eagle.app.getPath('temp');
        thumbPath = path.join(tempDir, `eagle_thumb_${Date.now()}.jpg`);
        await downloadFile(thumbnailPathOrUrl, thumbPath);
      }

      if (fs.existsSync(thumbPath)) {
        const item = await eagle.item.getById(itemId);
        item?.setCustomThumbnail && await item.setCustomThumbnail(thumbPath);
        if (thumbPath !== thumbnailPathOrUrl) try { fs.unlinkSync(thumbPath); } catch(e) {}
      }
    } catch(e) {}
  }

  return itemId;
}

function downloadFile(url, destPath, progressCallback) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;

    const request = protocol.get({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      timeout: HTTP_TIMEOUT,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' }
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const redirect = response.headers.location;
        if (!redirect) return reject(new Error('Redirect failed'));
        return downloadFile(redirect.startsWith('http') ? redirect : new URL(redirect, url).toString(), destPath, progressCallback).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) return reject(new Error(`HTTP ${response.statusCode}`));

      const file = fs.createWriteStream(destPath);
      const total = parseInt(response.headers['content-length'], 10) || 0;
      let downloaded = 0;
      let lastProgressUpdate = 0;

      response.on('data', (chunk) => {
        downloaded += chunk.length;
        // Throttle progress updates to max 10/second (100ms minimum interval)
        const now = Date.now();
        if (progressCallback && total > 0 && (now - lastProgressUpdate >= 100)) {
          lastProgressUpdate = now;
          progressCallback(downloaded / total);
        }
      });

      response.pipe(file);
      file.on('finish', () => {
        // Send final 100% progress update
        if (progressCallback && total > 0) progressCallback(1);
        file.close(resolve);
      });
      file.on('error', (err) => { file.close(); try { fs.unlinkSync(destPath); } catch(e) {} reject(err); });
    });

    request.on('timeout', () => { request.destroy(); try { fs.unlinkSync(destPath); } catch(e) {} reject(new Error('Timeout')); });
    request.on('error', (err) => { try { fs.unlinkSync(destPath); } catch(e) {} reject(err); });
  });
}

module.exports = {
  init,
  downloadVideo,
  addToEagle,
  downloadFile,
  analyzeError,
  getDetailedErrorMessage,
  getFixSuggestion,
  findDownloadedFiles,
  isDirectVideoUrl,
};
