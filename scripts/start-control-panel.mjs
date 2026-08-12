import { startControlPanel } from '../control-panel/server.mjs';

const control = await startControlPanel({ manageSidecar: true });

async function shutdown() {
  try { await control.processManager.stop(); } catch {}
  control.server.close(() => process.exit(0));
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
