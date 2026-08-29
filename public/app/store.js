/**
 * Estado global do painel + conexão de tempo real (SSE).
 * As views assinam `onChange` e são renderizadas de novo quando algo muda.
 */
import { api } from './api.js';

const listeners = new Set();
const eventListeners = new Map();

export const state = {
  user: null,
  permissions: [],
  settings: {},
  menu: [],
  drivers: [],
  zones: [],
  counters: { open: 0, kitchen: 0, dispatch: 0 },
  connected: false,
};

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitChange() {
  for (const fn of listeners) fn(state);
}

/** Assina um evento do servidor (ex.: 'order:created'). '*' recebe todos. */
export function onServerEvent(name, fn) {
  if (!eventListeners.has(name)) eventListeners.set(name, new Set());
  eventListeners.get(name).add(fn);
  return () => eventListeners.get(name).delete(fn);
}

function dispatchServerEvent(name, data) {
  for (const fn of eventListeners.get(name) || []) fn(data, name);
  for (const fn of eventListeners.get('*') || []) fn(data, name);
}

export function can(permission) {
  if (!state.user) return false;
  if (state.permissions.includes('*')) return true;
  if (state.permissions.includes(permission)) return true;
  return state.permissions.includes(`${permission.split(':')[0]}:*`);
}

export async function loadSession() {
  const data = await api.me();
  state.user = data.user;
  state.permissions = data.permissions;
  state.settings = data.settings || {};
  emitChange();
  return data;
}

export async function refreshReference() {
  const tasks = [];
  if (can('menu:read')) tasks.push(api.menu().then((menu) => { state.menu = menu; }));
  if (can('drivers:read')) tasks.push(api.drivers().then((drivers) => { state.drivers = drivers; }));
  if (can('zones:read')) tasks.push(api.zones().then((zones) => { state.zones = zones; }));
  if (can('settings:read')) tasks.push(api.settings().then((settings) => { state.settings = settings; }));
  await Promise.allSettled(tasks);
  emitChange();
}

export async function refreshCounters() {
  if (!can('orders:read')) return;
  try {
    const orders = await api.orders('open=1&with_items=0');
    state.counters = {
      open: orders.length,
      kitchen: orders.filter((o) => ['recebido', 'em_preparo'].includes(o.status)).length,
      dispatch: orders.filter((o) => o.type === 'entrega' && o.courier === 'loja' && !o.driver_id && o.status !== 'em_entrega').length,
    };
    emitChange();
  } catch { /* contadores são best-effort */ }
}

let source = null;

export function connectRealtime() {
  if (source) source.close();
  source = new EventSource('/api/events');
  const names = [
    'hello', 'order:created', 'order:updated', 'order:status', 'order:rated',
    'route:created', 'route:started', 'route:updated', 'route:finished', 'route:cancelled',
    'driver:status', 'driver:position', 'driver:updated', 'dispatch:auto',
    'menu:updated', 'zones:updated',
  ];
  for (const name of names) {
    source.addEventListener(name, (event) => {
      let data = {};
      try { data = JSON.parse(event.data); } catch { /* evento sem corpo */ }
      if (name === 'hello') { state.connected = true; emitChange(); return; }
      dispatchServerEvent(name, data);
      if (name.startsWith('order:') || name.startsWith('route:')) refreshCounters();
    });
  }
  source.onerror = () => { state.connected = false; emitChange(); };
  source.onopen = () => { state.connected = true; emitChange(); };
  return source;
}

export function disconnectRealtime() {
  if (source) { source.close(); source = null; }
  state.connected = false;
}
