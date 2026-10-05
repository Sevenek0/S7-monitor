/**
 * Fałszywa strona WWW. Ścieżki: / (OK), /redirect (302 → /), /error (500), /slow (opóźnienie).
 * GET /__control?down=1 — wszystko zwraca 503.
 */
import { startServer } from './util.js';

export async function startSiteMock({ port = 0, slowMs = 15000 } = {}) {
  const state = { down: false, delayMs: 0 };
  const s = await startServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__control') {
      if (url.searchParams.has('down')) state.down = url.searchParams.get('down') === '1';
      if (url.searchParams.has('delay')) state.delayMs = Number(url.searchParams.get('delay'));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(state));
    }
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    if (state.down) { res.writeHead(503, { 'content-type': 'text/html' }); return res.end('<h1>Service Unavailable</h1>'); }
    if (url.pathname === '/redirect') { res.writeHead(302, { location: '/' }); return res.end(); }
    if (url.pathname === '/error') { res.writeHead(500); return res.end('błąd'); }
    if (url.pathname === '/slow') { await new Promise((r) => setTimeout(r, slowMs)); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>S7</title><h1>Witaj na stronie S7 RP</h1>');
  }, port);
  return { ...s, state };
}
