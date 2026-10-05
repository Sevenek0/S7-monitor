// Web Push (iPhone PWA i przeglądarki). Uprawnienia prosimy WYŁĄCZNIE po kliknięciu.
import { api } from './api.js';
import { state } from './store.js';
import { isIOS, isStandalone, isDesktopApp } from './util.js';

function b64ToUint8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function pushSupport() {
  if (isDesktopApp()) return { ok: false, reason: 'desktop' };
  if (isIOS() && !isStandalone()) return { ok: false, reason: 'ios-browser' };
  if (!window.isSecureContext) return { ok: false, reason: 'insecure' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return { ok: false, reason: 'unsupported' };
  return { ok: true };
}

export async function pushStatus() {
  const sup = pushSupport();
  if (!sup.ok) return { ...sup, permission: null, subscribed: false };
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return { ok: true, permission: Notification.permission, subscribed: Boolean(sub) };
}

/** Wywoływać bezpośrednio z handlera kliknięcia (wymóg iOS). */
export async function enablePush() {
  // Najpierw prośba o zgodę — jako pierwsza operacja asynchroniczna po geście użytkownika.
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Powiadomienia są zablokowane. Odblokuj je w ustawieniach systemu.' : 'Nie udzielono zgody na powiadomienia.');
  const reg = await navigator.serviceWorker.ready;
  const key = state.me?.vapidPublicKey || (await api('/push/key')).publicKey;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(key) });
  await api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  }
}

export const sendTestPush = () => api('/push/test', { method: 'POST' });
