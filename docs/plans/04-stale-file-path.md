# 04 — The session's file path goes stale when the download completes

**Severity:** high. Every transcode that starts during a download fails or gets evicted once the download completes.

## Root cause

- `resolveVideoPath` (`backend/src/services/videoFileResolver.ts:31`) prefers `name.part`. A session created during the download stores that path.
- `getOrCreateSession` returns an existing session without refreshing `filePath`.
- When the download completes, Transmission renames `x.mkv.part` to `x.mkv`. After that:
  - `startGeneration` (`ffmpegProcess.ts:229`) throws "Source file not found".
  - `cacheEvictor.tryResumeSession` (`cacheEvictor.ts:133`) marks the job failed and deletes the whole cache.
  - `transcodeResumer` marks the job failed on the next boot.

## Steps

1. Add the following to `sessionRegistry`:
   ```ts
   async refreshFilePath(session: HlsSession): Promise<boolean> {
     const info = await torrentManager.getVideoFileInfo(session.infoHash);
     if (!info) return false;               // neither name nor name.part exists
     if (info.path !== session.filePath) {
       log.info(`[${session.sessionKey}] File path changed: ${session.filePath} -> ${info.path}`);
       session.filePath = info.path;
       transcodeJobManager.updateFilePath(session.infoHash, info.path).catch(...);
     }
     return true;
   }
   ```
2. Add `updateFilePath(infoHash, path)` to `transcodeJobManager`.
3. Call `refreshFilePath` in these places:
   - `startGeneration`, replacing the `existsSync` check; throw only if it returns `false`
   - `getOrCreateSession`, on the existing-session path (this is free once plan 10 removes the extra probe)
   - `cacheEvictor.tryResumeSession`, replacing `existsSync`
   - `transcodeResumer`, replacing `existsSync(job.filePath)`, before the probe
4. Running FFmpeg processes need no change, because on Linux an open file handle stays valid after a rename.
5. This is optional: `torrentManager.getVideoFileInfo` builds the path from `TORRENT_DOWNLOAD_PATH` and ignores Transmission's `downloadDir`. Keep that behaviour, because the containers use different path layouts, but add a comment explaining why.

## Tests

- **Unit test**, with `torrentManager` mocked and a temp directory: create the session on `x.mkv.part`, rename the file to `x.mkv`, call `ensureTranscodingStarted` → FFmpeg is spawned with `x.mkv`, and the database update is called.
- **Unit test:** if both files are missing, `refreshFilePath` returns `false`, and the evictor marks the job failed.

## Done when

Starting playback of an HEVC MKV during its download, letting the download finish, then seeking far ahead continues transcoding without errors.
