import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfig } from '../src/config.js';

export function tmpConfig(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's7test-'));
  return createConfig({ DATA_DIR: dir, APP_PASSWORD: 'tajne-haslo', APP_SECRET: 'test-secret', TICK_MS: '50', ...extra });
}

export async function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ srv, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) });
    });
  });
}
