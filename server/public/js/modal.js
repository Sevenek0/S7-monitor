// Proste okna modalne (na telefonie jako arkusz od dołu).
import { esc } from './util.js';

export function openModal(inner, { onClose } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${inner}</div>`;
  const prevFocus = document.activeElement;
  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
    if (!document.querySelector('.modal-wrap') && !document.querySelector('.panel.open')) document.body.classList.remove('no-scroll');
    prevFocus?.focus?.();
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(wrap);
  document.body.classList.add('no-scroll');
  const first = wrap.querySelector('input, select, button.primary, button');
  setTimeout(() => first?.focus(), 30);
  return { el: wrap.firstElementChild, close };
}

export function confirmDialog({ title, text = '', ok = 'Potwierdź', danger = false }) {
  return new Promise((resolve) => {
    let result = false;
    const m = openModal(`<h2>${esc(title)}</h2>${text ? `<p class="sec">${esc(text)}</p>` : ''}
      <div class="btn-row"><button class="btn" data-a="no">Anuluj</button><button class="btn ${danger ? 'danger armed' : 'primary'}" data-a="yes">${esc(ok)}</button></div>`,
    { onClose: () => resolve(result) });
    m.el.querySelector('[data-a="no"]').addEventListener('click', () => m.close());
    m.el.querySelector('[data-a="yes"]').addEventListener('click', () => { result = true; m.close(); });
  });
}
