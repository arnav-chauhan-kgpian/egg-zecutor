import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './lib/prisma';
import {
  recoverOrphanedRuns,
  startReconciler,
  stopReconciler,
} from './modules/executions/execution.reconciler';
import { engineInfo } from './services/execution';

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`API listening on http://localhost:${env.PORT} [${env.NODE_ENV}]`);
  console.log(
    `Execution engine: ${engineInfo.kind}` +
      (engineInfo.endpoint ? ` (${engineInfo.endpoint})` : '') +
      (engineInfo.usesCallback ? ` — webhook ${engineInfo.callbackUrl}` : ' — inline'),
  );
  // Inline runs cannot survive a restart; clear them so the UI stops spinning.
  void recoverOrphanedRuns().catch((error) =>
    console.error('[reconciler] recovery failed:', error instanceof Error ? error.message : error),
  );
  // No-op unless the backend defers results (Judge0).
  startReconciler();
});

async function shutdown(signal: string) {
  console.log(`\n${signal} received, shutting down...`);
  stopReconciler();
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });

  // Don't hang forever if connections refuse to drain.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
