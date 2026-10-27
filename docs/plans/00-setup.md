# 00 — Make the stack runnable

**Severity:** blocker. None of the other fixes can be tested until the stack starts.

## Problems

- `setup.sh` copies `backend/.env.example`, which doesn't exist. The script has `set -e`, so it aborts at that step.
- `HLS_CACHE_PATH` defaults to `/cache/hls` (`backend/src/hls/types.ts`). When the backend runs locally as a normal user, it can't create that directory, so `bootstrap()` fails.
- `compose.services.yaml` builds Transmission from `./transmission/build`, which doesn't exist. Sequential download needs Transmission 4.1 or later.
- `backend/Dockerfile` runs `src/index.ts`, but the entry point is `src/server.ts`.
- `compose.yaml` doesn't set `DATABASE_URL` for the backend, and the backend doesn't depend on `postgres`.
- `backend/drizzle/` doesn't exist, and nothing runs migrations.
- `backend/data.db` (an empty SQLite file) and `backend/data/favourites.json` are leftovers from before the move to Postgres.
- `app/src/config.ts` hardcodes `http://localhost`, so the UI only works on the host machine.

## Steps

1. Run `git init` and commit everything as a baseline.
2. Create `backend/.env.example`:
   ```
   JACKETT_API_KEY=your_api_key_here
   JACKETT_BASE_URL=http://localhost:9117
   JACKETT_INDEXER=1337x
   TMDB_API_KEY=
   DATABASE_URL=postgres://popcorn:<your-local-password>@localhost:5432/popcorn
   TRANSMISSION_URL=http://localhost:9091/transmission/rpc
   TORRENT_DOWNLOAD_PATH=../transmission/downloads
   HLS_CACHE_PATH=./cache/hls
   ```
   `JACKETT_API_KEY=your_api_key_here` must stay exactly as written, because `setup.sh` matches that placeholder when it fills in the key.
3. In `hls/types.ts`, change the `cachePath` default to `./cache/hls`. Add `backend/cache/` and `backend/.env` to `.gitignore`.
4. Transmission image:
   - Look for the original `transmission/build/Dockerfile` in an older copy of the repo from before the restructure.
   - If it can't be found, write a Dockerfile that builds Transmission 4.1 or later from source on `lscr.io/linuxserver/transmission`'s base, keeping the same volumes and ports.
   - Until then, switch back to the commented-out stock image and record in the README that sequential download is unavailable.
5. In `backend/Dockerfile`, change `CMD` to `["bun", "run", "src/server.ts"]`.
6. In `compose.yaml`, give the backend a `DATABASE_URL` built from environment variables, and add `postgres: { condition: service_healthy }` to its `depends_on`. Also pass `TMDB_API_KEY` through.
7. Migrations:
   - Run `bun run db:generate` and commit `backend/drizzle/`.
   - In `setup.sh`, run `(cd backend && bun run db:migrate)` once Postgres reports healthy.
   - In Docker, run the migration before the server starts: either `CMD ["sh", "-c", "bun run db:migrate && bun run src/server.ts"]`, or a separate migrate service.
8. Leftover data:
   - Compare `data/favourites.json` with the `favourites` table.
   - If any favourites exist only in the JSON file, import them with a one-off script.
   - Then delete `backend/data.db` and `backend/data/`.
9. In `app/src/config.ts`, set `SERVER_HOST = \`${location.protocol}//${location.hostname}\``.
10. Fix the README:
    - Correct the `./dev up` command (the script is `./dev.sh`).
    - Fix the "The Priate Bay" typo.
    - Change the `src/index.ts` reference to `src/server.ts`.

## Done when

- On a fresh clone, `./setup.sh` completes without errors.
- `bun run dev` in both `backend/` and `app/` starts with no manual steps.
- `docker compose up` brings up the full stack.
- From another machine on the LAN, the home page loads.
