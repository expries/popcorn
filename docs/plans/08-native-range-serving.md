# 08 — Native streaming can serve zeros for undownloaded data

**Severity:** medium.

## Root cause

- `handleNativeStream` / `torrentManager.createVideoStream` read the preallocated `.part` file with no check of which pieces exist. The browser reads ahead past the downloaded region and receives zero bytes, which surfaces as `MediaError` code 3. `VideoPlayer.handleVideoError` explains the error to the user but doesn't prevent it.
- Range parsing (`backend/src/routes/stream/nativeStream.ts:52`) has three gaps:
  - `bytes=-N` (the last N bytes) parses as `NaN`
  - `end` isn't clamped to `size - 1`
  - an unsatisfiable range isn't answered with 416

## Steps

1. **Range parser.** Add a pure function `parseRange(header, size): { start, end } | 'unsatisfiable' | null` in `routes/stream/range.ts`:
   - `bytes=A-B`: clamp `B` to `size - 1`. If `A > B` or `A >= size`, the range is unsatisfiable.
   - `bytes=A-`: `end = min(A + 10 MiB, size - 1)`. This is the existing chunking behaviour; keep it.
   - `bytes=-N`: `start = max(0, size - N)`, `end = size - 1`.
   - Multiple ranges (`a-b,c-d`): use the first one only.
   - Unsatisfiable → 416 with `Content-Range: bytes */size`.
2. **Downloaded byte ranges.** Add `torrentManager.getVideoDownloadedByteRanges(infoHash): Promise<Array<[number, number]> | null>`. It's the same calculation as `calculateDownloadedRanges`, but in absolute file bytes rather than fractions. Refactor so the fraction version is derived from the byte version. Memoise it per hash for 1 s (see plan 10). Return `null` when the torrent is finished, meaning "everything is available".
3. **Serving logic** in `handleNativeStream`, for incomplete torrents:
   - If `start` is inside a downloaded range, set `end = min(end, rangeEnd)` and return 206. Browsers accept a shorter 206 and request the rest.
   - If `start` is not downloaded yet:
     - Poll every 500 ms for up to 10 s, until it is downloaded or the request is aborted (`req.signal`).
     - If it becomes available, serve as above.
     - Otherwise return 503 with `Retry-After: 2`.
   - A request without a `Range` header for an incomplete file: treat it as `bytes=0-` so the downloaded-range logic applies, and return 206.
4. **Optional:** when `start` is far beyond the contiguous prefix, ask Transmission to prioritise those pieces. Leave this out for now; sequential download plus the frontend's seek gating covers the normal case.
5. **Frontend:** once the server never sends zeros, remove the special case for code 3 on incomplete files from `VideoPlayer.handleVideoError`.

## Tests

- **`parseRange` unit tests:** `bytes=0-`, `bytes=100-199`, `bytes=-500`, `bytes=900-2000` on a 1000-byte file (clamped), `bytes=1000-` (unsatisfiable), garbage input (null).
- **Serving unit test**, with a fake byte-range provider: `start` inside a range → truncated `end`. `start` in a hole that fills after 1 s → served. `start` in a hole that stays empty → 503.

## Done when

Playing the YIFY MP4 natively while it downloads (with the download throttled in Transmission) never shows a decode error, and the network tab shows 206 responses that stop at the downloaded boundary.
