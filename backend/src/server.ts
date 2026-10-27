import { cacheEvictor, ffmpegProcess, segmentCache } from './hls';
import { createStreamServer } from './routes/stream';
import { createTRPCServer } from './routes/trpc/server';
import { resumeIncompleteTranscodes } from './services/transcodeResumer';
import { createLogger } from './utils/logger';

const log = createLogger('Server');
const hlsLog = createLogger('HLS');
const resumeLog = createLogger('Resume');

const TRPC_PORT = 3001;
const STREAM_PORT = 3002;

async function bootstrap() {
  // Initialize HLS cache
  await segmentCache.ensureCacheDir();
  hlsLog.info('Cache directory initialized');

  // Start cache evictor
  cacheEvictor.start();

  // Start servers
  const trpcServer = createTRPCServer(TRPC_PORT);
  createStreamServer(STREAM_PORT);

  log.info(`tRPC Server running at ${trpcServer.url}`);
  log.info(`Stream Server running at http://localhost:${STREAM_PORT}`);

  // Resume incomplete transcodes after servers are ready
  // Run in background to not block startup
  setTimeout(async () => {
    try {
      await resumeIncompleteTranscodes();
    } catch (error) {
      resumeLog.error('Failed to resume transcodes:', error);
    }
  }, 2000);
}

function shutdown() {
  log.info('Shutting down...');
  cacheEvictor.stop();
  ffmpegProcess.killAll();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

bootstrap();
