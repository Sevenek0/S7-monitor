// Lekkie wykresy SVG bez zależności: sparkline, wykres liniowy z crosshairem, pasek timeline.
import { esc, timeOnly, dayOnly, dateTime, num } from './util.js';

/** Sparkline jako string SVG (skalowany do kontenera). Czerwone znaczniki = kubełki z awarią. */
export function sparkline(points, key, { color = 'var(--series-1)', from, to, bucketMs } = {}) {
  const W = 300; const H = 40; const pad = 3;
  if (!points?.length || from == null) return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><line x1="0" y1="${H - pad}" x2="${W}" y2="${H - pad}" stroke="var(--surface-3)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
  const vals = points.map((p) => p[key]).filter((v) => v != null);
  const max = Math.max(1e-9, ...vals);
  const min = key === 'pl' || key === 'cpu' ? 0 : Math.min(...vals) * 0.8;
  const x = (t) => ((t - from) / (to - from)) * W;
  const y = (v) => H - 6 - ((v - min) / (max - min || 1)) * (H - 6 - pad);
  let d = ''; let area = ''; let prevT = null; let segStart = null; let lastX = 0;
  const closeArea = () => { if (segStart != null) area += `L${lastX.toFixed(1)},${H}L${segStart.toFixed(1)},${H}Z`; };
  for (const p of points) {
    const v = p[key];
    if (v == null) { closeArea(); segStart = null; prevT = null; continue; }
    const px = x(p.t + bucketMs / 2); const py = y(v);
    if (prevT == null || p.t - prevT > bucketMs * 1.5) {
      closeArea();
      d += `M${px.toFixed(1)},${py.toFixed(1)}`; area += `M${px.toFixed(1)},${H}L${px.toFixed(1)},${py.toFixed(1)}`; segStart = px;
    } else { d += `L${px.toFixed(1)},${py.toFixed(1)}`; area += `L${px.toFixed(1)},${py.toFixed(1)}`; }
    prevT = p.t; lastX = px;
  }
  closeArea();
  const bad = points.filter((p) => p.up != null && p.up < 100)
    .map((p) => `<rect x="${x(p.t).toFixed(1)}" y="${H - 3}" width="${Math.max(2, (bucketMs / (to - from)) * W).toFixed(1)}" height="3" fill="var(--critical)"/>`).join('');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${area}" fill="${color}" opacity=".14"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    ${bad}</svg>`;
}

function niceMax(v) {
  if (!v || v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/**
 * Wykres liniowy (jedna seria, jedna oś Y). Renderuje się do szerokości kontenera,
 * ma crosshair + tooltip. Zwraca funkcję sprzątającą.
 */
export function mountLineChart(el, { points, key, from, to, bucketMs, color = 'var(--series-1)', title, fmt = (v) => num(v), yMax, height = 170 }) {
  el.classList.add('chart');
  const data = points.filter((p) => p[key] != null);
  const values = data.map((p) => p[key]);
  const peak = values.length ? Math.max(...values) : 0;
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  el.innerHTML = `<div class="chart-title"><span>${esc(title)}</span><span class="muted">${values.length ? `śr. ${esc(fmt(avg))} · maks. ${esc(fmt(peak))}` : 'brak danych'}</span></div><div class="plot"></div><div class="tip hidden"></div>`;
  const plot = el.querySelector('.plot');
  const tip = el.querySelector('.tip');
  const span = to - from;
  const longRange = span > 36 * 3600e3;

  const render = () => {
    const W = Math.max(200, plot.clientWidth);
    const H = height;
    const top = niceMax(Math.max(yMax ?? 0, peak * 1.1));
    const labelW = Math.max(...[0, top / 2, top].map((v) => String(fmt(v)).length)) * 6.6 + 12;
    const m = { l: Math.max(30, Math.ceil(labelW)), r: 12, t: 10, b: 24 };
    const iw = W - m.l - m.r; const ih = H - m.t - m.b;
    const x = (t) => m.l + ((t - from) / span) * iw;
    const y = (v) => m.t + ih - (v / top) * ih;

    let grid = '';
    for (let i = 0; i <= 2; i++) {
      const v = (top / 2) * i; const yy = y(v).toFixed(1);
      grid += `<line x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}" stroke="var(--surface-3)" stroke-width="1"/>`;
      grid += `<text x="${m.l - 8}" y="${yy}" dy="4" text-anchor="end" fill="var(--text-muted)" font-size="11">${esc(fmt(v))}</text>`;
    }
    const ticks = W < 420 ? 3 : 5;
    let xl = '';
    for (let i = 0; i <= ticks; i++) {
      const t = from + (span / ticks) * i;
      const anchor = i === 0 ? 'start' : i === ticks ? 'end' : 'middle';
      xl += `<text x="${x(t).toFixed(1)}" y="${H - 6}" text-anchor="${anchor}" fill="var(--text-muted)" font-size="11">${esc(longRange ? dayOnly(t) : timeOnly(t))}</text>`;
    }
    let d = ''; let area = ''; let prev = null; let segX = null; let lastX = 0; const base = y(0);
    const close = () => { if (segX != null) area += `L${lastX.toFixed(1)},${base}L${segX.toFixed(1)},${base}Z`; };
    for (const p of data) {
      const px = x(p.t + bucketMs / 2); const py = y(p[key]);
      if (prev == null || p.t - prev > bucketMs * 1.5) {
        close();
        d += `M${px.toFixed(1)},${py.toFixed(1)}`; area += `M${px.toFixed(1)},${base}L${px.toFixed(1)},${py.toFixed(1)}`; segX = px;
      } else { d += `L${px.toFixed(1)},${py.toFixed(1)}`; area += `L${px.toFixed(1)},${py.toFixed(1)}`; }
      prev = p.t; lastX = px;
    }
    close();
    const dots = data.length < 30 ? data.map((p) => `<circle cx="${x(p.t + bucketMs / 2).toFixed(1)}" cy="${y(p[key]).toFixed(1)}" r="3" fill="${color}"/>`).join('') : '';
    plot.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
      ${grid}${xl}
      <path d="${area}" fill="${color}" opacity=".12"/>
      <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
      <line class="xh" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" stroke="var(--text-muted)" stroke-width="1" visibility="hidden"/>
      <circle class="xd" r="4.5" fill="${color}" stroke="var(--surface-2)" stroke-width="2" visibility="hidden"/>
      <rect x="${m.l}" y="${m.t}" width="${iw}" height="${ih}" fill="transparent" class="hit"/>
    </svg>`;

    const svg = plot.firstElementChild;
    const xh = svg.querySelector('.xh'); const xd = svg.querySelector('.xd');
    const hide = () => { xh.setAttribute('visibility', 'hidden'); xd.setAttribute('visibility', 'hidden'); tip.classList.add('hidden'); };
    const move = (ev) => {
      if (!data.length) return;
      const rect = svg.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const t = from + ((px - m.l) / iw) * span;
      let best = data[0];
      for (const p of data) if (Math.abs(p.t + bucketMs / 2 - t) < Math.abs(best.t + bucketMs / 2 - t)) best = p;
      const bx = x(best.t + bucketMs / 2); const by = y(best[key]);
      xh.setAttribute('x1', bx); xh.setAttribute('x2', bx); xh.setAttribute('visibility', 'visible');
      xd.setAttribute('cx', bx); xd.setAttribute('cy', by); xd.setAttribute('visibility', 'visible');
      tip.innerHTML = `<b>${esc(fmt(best[key]))}</b>${esc(dateTime(best.t))}${best.up != null && best.up < 100 ? ` · dostępność ${esc(num(best.up))}%` : ''}`;
      tip.classList.remove('hidden');
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.min(Math.max(bx, tw / 2 + 4), W - tw / 2 - 4)}px`;
      tip.style.top = `${Math.max(0, by - 52)}px`;
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerdown', move);
    svg.addEventListener('pointerleave', hide);
  };

  render();
  let lastW = plot.clientWidth;
  const ro = new ResizeObserver(() => { if (plot.clientWidth !== lastW) { lastW = plot.clientWidth; render(); } });
  ro.observe(plot);
  return () => ro.disconnect();
}

/** Pasek timeline statusu: zakres dzielony na `segments` odcinków. */
export function timeline(buckets, { from, to, segments = 60 }) {
  const seg = (to - from) / segments;
  const acc = Array.from({ length: segments }, () => ({ n: 0, up: 0 }));
  for (const b of buckets) {
    const i = Math.min(segments - 1, Math.max(0, Math.floor((b.t - from) / seg)));
    acc[i].n += b.n; acc[i].up += (b.up / 100) * b.n;
  }
  const spans = acc.map((a, i) => {
    const t0 = from + i * seg;
    if (!a.n) return `<span title="${esc(dateTime(t0))}: brak danych"></span>`;
    const u = (a.up / a.n) * 100;
    const s = u >= 99.95 ? 'up' : u <= 0.05 ? 'down' : 'part';
    return `<span data-s="${s}" title="${esc(dateTime(t0))}: ${esc(num(u))}% dostępności"></span>`;
  }).join('');
  return `<div class="timeline" role="img" aria-label="Oś czasu dostępności">${spans}</div>`;
}
