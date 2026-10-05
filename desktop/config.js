// Konfiguracja aplikacji desktop: userData/config.json  { serverUrl }
const fs = require('node:fs');
const path = require('node:path');

function createConfigStore(dir) {
  const file = path.join(dir, 'config.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* pierwszy start */ }
  return {
    file,
    get: (k) => data[k],
    set(k, v) {
      data[k] = v;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    },
  };
}

/** Normalizuje adres serwera do origin (https://monitor.example.pl). Rzuca błąd po polsku. */
function normalizeServerUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Podaj adres serwera.');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) throw new Error('Adres musi zaczynać się od https://');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw new Error('To nie wygląda na poprawny adres.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Adres musi zaczynać się od https://');
  return u.origin;
}

module.exports = { createConfigStore, normalizeServerUrl };
