/**
 * Zamienia przejścia UP↔DOWN na powiadomienia (bez spamu przy WARN).
 */
export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h} h ${rm} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d} d ${rh} h` : `${d} d`;
}

export function buildNotification(t) {
  const { monitor } = t;
  if (t.to === 'down') {
    return {
      title: `PADŁ: ${monitor.name}${t.reason ? ` (${t.reason})` : ''}`,
      body: `Monitor ${monitor.name} nie odpowiada${t.reason ? `: ${t.reason}` : ''}.`,
      monitorId: monitor.id, kind: 'down', tag: `s7-${monitor.id}`, url: `/#/m/${monitor.id}`,
    };
  }
  if (t.to === 'up') {
    const d = t.downtimeMs != null ? ` (przerwa ${formatDuration(t.downtimeMs)})` : '';
    return {
      title: `Działa znowu: ${monitor.name}${d}`,
      body: `${monitor.name} znów działa.`,
      monitorId: monitor.id, kind: 'up', tag: `s7-${monitor.id}`, url: `/#/m/${monitor.id}`,
    };
  }
  return null;
}

export function attachNotifier({ bus, push, log = console }) {
  const handler = async (t) => {
    const n = buildNotification(t);
    if (!n) return;
    log.log?.(`[powiadomienie] ${n.title}`);
    if (!push) return;
    try {
      const stats = await push.sendAll(n);
      bus.emit('push-sent', { notification: n, stats });
    } catch (err) {
      log.error?.('[powiadomienie] Błąd:', err);
    }
  };
  bus.on('transition', handler);
  return () => bus.off('transition', handler);
}
