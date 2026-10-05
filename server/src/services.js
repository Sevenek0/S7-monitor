import { openDb } from './db.js';
import { createStore } from './store.js';
import { createBus } from './bus.js';
import { createEngine } from './engine.js';
import { createScheduler } from './scheduler.js';
import { createHistory } from './history.js';
import { createRetention } from './retention.js';
import { createPush, loadVapidKeys } from './push.js';
import { attachNotifier } from './notifier.js';
import { createPteroClient } from './ptero-client.js';
import { createApp } from './app.js';
import { monitorRoutes } from './routes/monitors.js';
import { pteroRoutes } from './routes/ptero.js';
import { pushRoutes } from './routes/push.js';
import { eventRoutes } from './routes/events.js';

/** Składa wszystkie usługi aplikacji. Używane przez index.js, dev:mock i testy. */
export function createServices(config, overrides = {}) {
  const db = overrides.db || openDb(config.dbFile);
  const store = createStore(db);
  const bus = createBus();
  const ptero = overrides.ptero || createPteroClient({ url: config.ptero.url, key: config.ptero.key });
  const engine = createEngine({ db, store, bus, ctx: { ptero, ...(overrides.ctx || {}) } });
  const scheduler = createScheduler({ store, engine, tickMs: config.tickMs, concurrency: config.concurrency });
  const history = createHistory(db);
  const retention = createRetention({ db, days: config.retentionDays });
  const push = createPush({ db, vapid: loadVapidKeys(config.dataDir), subject: config.vapidSubject, sender: overrides.pushSender });
  attachNotifier({ bus, push });

  const deps = { config, db, store, bus, ptero, engine, scheduler, history, push };
  const events = eventRoutes({ bus, store });
  const app = createApp({
    config,
    limiter: overrides.limiter,
    routes: [monitorRoutes(deps), pteroRoutes(deps), pushRoutes(deps), events],
  });
  return { ...deps, retention, app, events,
    start() { scheduler.start(); retention.start(); },
    stop() { scheduler.stop(); retention.stop(); },
  };
}
