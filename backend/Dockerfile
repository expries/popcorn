FROM oven/bun:1 AS base

# Install FFmpeg for video transcoding
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY src ./src
COPY tsconfig.json ./

# Expose ports for tRPC API and streaming server
EXPOSE 3001 3002

# Run the server
CMD ["bun", "run", "src/index.ts"]
