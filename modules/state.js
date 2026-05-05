// Shared mutable state — all modules read/write through this object.
// Primitives (ytDlpPath, resolvedFfmpegPath, resolvedDenoPath, tempDir) MUST live here
// so mutations from any module are visible to all others.
// Object-typed state (settings, downloadQueue, activeProcesses) are
// passed by reference — mutations auto-propagate.

module.exports = {
  ytDlpPath: null,
  resolvedFfmpegPath: null,
  resolvedDenoPath: null,
  tempDir: null,
  settings: {},
  downloadQueue: [],
  activeProcesses: new Map(),
  pendingPreviews: new Map()
};
