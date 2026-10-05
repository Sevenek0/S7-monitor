import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

/** Klucze VAPID generowane przy pierwszym starcie i zapisywane w data/vapid.json. */
export function loadVapidKeys(dataDir) {
  const file = path.join(dataDir, 'vapid.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  console.log('[push] Wygenerowano klucze VAPID (data/vapid.json)');
  return keys;
}

/**
 * Usługa Web Push. `sender` można podmienić w testach (domyślnie web-push).
 */
export function createPush({ db, vapid, subject, sender = webpush.sendNotification.bind(webpush), log = console }) {
  const q = {
    upsert: db.prepare(`INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`),
    all: db.prepare('SELECT * FROM push_subscriptions'),
    del: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions'),
  };
  const options = { vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 3600, urgency: 'high' };

  return {
    publicKey: vapid.publicKey,
    subscribe(sub, userAgent = '') {
      if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
        throw new Error('Niepoprawna subskrypcja');
      }
      q.upsert.run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, String(userAgent).slice(0, 200), Date.now());
    },
    unsubscribe(endpoint) { return q.del.run(endpoint).changes > 0; },
    count: () => q.count.get().n,
    /** Wysyła powiadomienie do wszystkich. Subskrypcje z 404/410 są usuwane. */
    async sendAll(payload) {
      const subs = q.all.all();
      const body = JSON.stringify(payload);
      const stats = { sent: 0, removed: 0, failed: 0 };
      await Promise.all(subs.map(async (s) => {
        try {
          await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, options);
          stats.sent++;
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            q.del.run(s.endpoint);
            stats.removed++;
          } else {
            stats.failed++;
            log.warn?.(`[push] Błąd wysyłki (${err.statusCode || err.message})`);
          }
        }
      }));
      return stats;
    },
  };
}
