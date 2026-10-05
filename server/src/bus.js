import { EventEmitter } from 'node:events';

/** Szyna zdarzeń aplikacji (silnik → SSE, powiadomienia). */
export function createBus() {
  const bus = new EventEmitter();
  bus.setMaxListeners(200);
  return bus;
}
