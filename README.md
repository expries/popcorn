# Popcorn

A streaming media application with torrent integration.

This project is provided for lawful use with content you are authorized to
access. It does not host or distribute copyrighted media.

## Prerequisites

- [Bun](https://bun.sh) runtime
- Docker & Docker Compose

## Quick Start

```bash
./setup.sh
```

This installs dependencies, starts services, and configures the Jackett API key automatically.

Then:

1. Optional: Open Jackett at http://localhost:9117 and configure indexers (default indexers: 1337x, Nyaa.si, The Priate Bay, TheRARBG)
2. Start the backend: `cd backend && bun run dev`
3. Start the frontend: `cd app && bun run dev`
4. Open http://localhost:3000

## Manual Setup

<details>
<summary>Click to expand manual setup steps</summary>

### 1. Install dependencies

```bash
cd app && bun install
cd ../backend && bun install
```

### 2. Start external services

```bash
./dev up
```

### 3. Configure Jackett

1. Open Jackett at http://localhost:9117
2. Copy the API key from the top of the page
3. Add at least one indexer (e.g., 1337x)
4. Create a `.env` file in the backend folder:

```bash
cp backend/.env.example backend/.env
# Edit backend/.env and add your Jackett API key
```

### 4. Start the backend

```bash
cd backend && bun run dev
```

### 5. Start the frontend

```bash
cd app && bun run dev
```

</details>

The app will be available at http://localhost:3000

## Docker Compose

### Development (services only)

```bash
./dev up     # Start services
./dev down   # Stop services
```

### Production (full stack)

```bash
docker compose up
```

## Project Structure

```
popcorn/
├── app/                    # Frontend (React + TanStack Router)
│   └── src/
│       ├── main.tsx        # React bootstrap
│       ├── providers.tsx   # Provider composition
│       └── router.tsx      # Route definitions
├── backend/                # Backend (Bun + tRPC)
│   └── src/
│       ├── index.ts        # Server bootstrap
│       └── routes/
│           ├── trpc/       # tRPC router & server
│           └── stream/     # HLS streaming server
├── compose.yaml            # Full stack compose
└── compose.services.yaml   # External services only
```
