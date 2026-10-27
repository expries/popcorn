# Fix plans

One plan per issue found in the codebase analysis. Each plan lists the root cause, the files it touches, the steps, the tests, and what "done" means.

| # | Plan | Severity | Depends on |
|---|------|----------|------------|
| 00 | [Make the stack runnable](00-setup.md) | Blocker | – |
| 01 | [MKV H.264/AAC treated as native](01-mkv-native-strategy.md) | High | Solved by 07 |
| 02 | [Restart start time is wrong in copy modes](02-restart-alignment.md) | High | 09 (persisted durations) |
| 03 | [Planned segment count can be wrong](03-completion-detection.md) | High | 06 |
| 04 | [File path goes stale when the download completes](04-stale-file-path.md) | High | – |
| 05 | [Safety cap disappears near the download edge](05-safety-cap.md) | High | 02 |
| 06 | [Database status is never updated](06-job-status.md) | Medium | – |
| 07 | [Single set of compatibility rules](07-compatibility-rules.md) | High | – |
| 08 | [Native streaming can serve zeros](08-native-range-serving.md) | Medium | – |
| 09 | [One `canSeekTo` and persisted durations](09-can-seek-to.md) | Medium | – |
| 10 | [Probe and poll cost per request](10-performance.md) | Medium | 07 |
| 11 | [Smaller issues](11-small-fixes.md) | Low | various |

## Build order

1. **00**, plus `git init` with a baseline commit (this directory is not yet a git repo).
2. **07**, which also closes 01. Everything else depends on the decision logic being correct.
3. **04**, the runId guard from **11**, and **06**.
4. **09** (persist durations) → **02** → **03** → **05**.
5. **08**.
6. **10**.
7. The rest of **11**.

## Manual check after every step

Run `bun test` in `backend/`. Then play each of the three files already in `transmission/downloads`:

- `Finding.Nemo…YIFY.mp4`: native path.
- `your.name…haiku[EtHD].mkv`: H.264 in MKV, the case from plan 01.
- `Predator Badlands…x265…BONE.mkv`: HEVC, full transcode.

Commit each plan separately, using conventional commit messages (`fix(hls): …`, `chore(setup): …`).
