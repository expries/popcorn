# 10 — Probe and poll cost per request

**Severity:** medium. This is not about correctness. It is CPU and RPC load that grows with the number of viewers and the request rate.
**Depends on:** [07](07-compatibility-rules.md), so the probe consumers are already consolidated.

## Root cause

- `getOrCreateSession` runs `probeFile` **before** checking for an existing session. `probeFile` spawns two ffprobe processes, one of them at `-v trace`, which logs every read the demuxer makes. This runs on every master playlist, variant playlist, segment and `/stats` request, and on SSE ticks while waiting.
- `/stream/:hash` and `/stats/:hash` probe again on their own. `statsHandler` also spawns a third ffprobe just to get the duration. `progressSSE` keeps a separate duration cache.
- `torrentManager.getTorrentByHash` (`services/torrentManager.ts:163`) fetches **all** torrents, with every field including the base64 `pieces` bitfield, and filters on the client. A single segment request calls it at least twice (`getDownloadProgress` and `getVideoFileInfo`), and each SSE client calls it once per second.

## Steps

1. **Session lookup before probing.** Restructure `getOrCreateSession`:
   - Look up any session for the infoHash with `getSessionByInfoHash`.
   - If one exists, apply the download-progress update and return it.
   - Only probe when there is no session.
   - Re-probe an existing session only when `codecInfo.moovAtStart === null`, the container is mp4 or mov, and more than 10 s have passed since the last probe (store `lastProbeAt`).
2. **Probe cache.** Add `hls/probeCache.ts`, holding `Map<path, { size, mtimeMs, info }>`. A cached entry is valid while `size` and `mtimeMs` are unchanged. For `.part` files they change constantly, so key incomplete files by path, cache for 10 s, and serve the cached info. Codec info doesn't change during a download except the moov flag, which step 1 handles. `/stream`, `/stats`, `progressSSE` and the resumer all use it. Delete `statsHandler.getVideoDuration` and `progressSSE`'s `durationCache`.
3. **Replace `checkMoovPosition`** with a direct atom reader in `hls/mp4Atoms.ts`:
   ```ts
   export async function findMoovPosition(path: string): Promise<boolean | null>
   ```
   - Open the file and read an 8-byte header at offset 0: a 32-bit size and a 4-character type.
   - If `size === 1`, read the 64-bit size from the next 8 bytes. If `size === 0`, the atom runs to the end of the file.
   - Stop when `moov` (return `true` if `mdat` hasn't been seen yet) or `mdat` (return `false` unless `moov` was seen first) is found.
   - Skip forward by `size` and repeat.
   - If a header is all zeros (not downloaded yet), past the end of the file, or invalid, return `null`.
   - Only call it when the container is mp4 or mov. For everything else return `null` without opening the file.
4. **Transmission RPC:**
   - Add `getTorrentByHash(hash, fields)`, which calls `transmissionClient.listTorrents([hash], fields)`. Check that `@ctrl/transmission`'s `listTorrents(ids, fields)` accepts hash strings. If not, call `request('torrent-get', { ids: [hash], fields })` directly.
   - Split the field lists. `STATS_FIELDS` has no `pieces` and no `files`. `FILE_FIELDS` adds `files` and `downloadDir`. `PIECE_FIELDS` adds `pieces`, `pieceSize`, `pieceCount` and `files`.
   - Add `utils/memo.ts`, a per-key in-flight-deduplicating memo with a TTL. Wrap `getTorrentStats` (1 s TTL), `getVideoFileInfo` (5 s, invalidated when the path changes, see plan 04) and `getVideoPieceProgress` (1 s).
5. **SSE fan-out (optional, after measuring):** run one ticker per infoHash, shared by every SSE client watching it, rather than a `setInterval` per connection.

## Tests

- **Unit test:** a second `getOrCreateSession` call for the same hash doesn't call `probeFile` (spy on it).
- **`findMoovPosition` fixtures,** generated with ffmpeg in a test setup step and skipped when ffmpeg is missing:
  - `-movflags +faststart` → `true`
  - the default (moov at end) → `false`
  - the first 64 KiB of a moov-at-end file → `null`
  - a 0-byte file → `null`
- **Memo unit test:** concurrent calls share one in-flight promise, and the value expires after the TTL.

## Done when

During steady HLS playback with one viewer, `ps` shows no ffprobe processes beyond the first probe, and Transmission RPC calls drop to about 1 per second per torrent (count them with a debug counter in `transmissionClient`).
