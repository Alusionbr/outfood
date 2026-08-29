import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './config.js';

let db = null;

export function getDb() {
  if (db) return db;
  const dir = path.dirname(config.dbPath);
  if (dir && dir !== ':memory:' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

/** Usado nos testes: banco isolado em memória. */
export function useDatabase(instance) {
  db = instance;
  return db;
}

export function createTestDb() {
  const instance = new DatabaseSync(':memory:');
  instance.exec('PRAGMA foreign_keys = ON;');
  migrate(instance);
  return instance;
}

export function migrate(instance) {
  const sql = fs.readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8');
  // WAL não é suportado em :memory:; ignorado silenciosamente pelo SQLite.
  instance.exec(sql);
  ensureDefaults(instance);
}

export const DEFAULT_SETTINGS = {
  store_name: 'Outfood',
  store_phone: '',
  store_address: '',
  store_lat: null,
  store_lon: null,
  city: 'Rio de Janeiro - RJ',
  delivery_radius_km: 10,
  default_fee_cents: 300,
  free_delivery_above_cents: 0,
  min_order_cents: 0,
  fee_mode: 'zona', // zona | km | fixo
  fee_per_km_cents: 150,
  avg_speed_kmh: 22,
  stop_minutes: 4,
  default_prep_minutes: 25,
  printer_width: '80',
  currency: 'BRL',
  auto_confirm: 1,
  service_hours: '18:00-23:30',
  pix_key: '',
  road_routing: 1,
  online_orders: 1,
  whatsapp_template: 'Ola {cliente}! Seu pedido {codigo} foi confirmado. Acompanhe: {link}',
  driver_commission_default_cents: 300,
};

function ensureDefaults(instance) {
  const insert = instance.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    insert.run(key, JSON.stringify(value));
  }
}

/* ------------------------------------------------------------------ *
 * Helpers de consulta                                                 *
 * ------------------------------------------------------------------ */

export function all(sql, ...params) {
  return getDb().prepare(sql).all(...params).map(plain);
}

export function get(sql, ...params) {
  const row = getDb().prepare(sql).get(...params);
  return row ? plain(row) : null;
}

export function run(sql, ...params) {
  return getDb().prepare(sql).run(...params);
}

export function exec(sql) {
  return getDb().exec(sql);
}

/** node:sqlite devolve objetos com prototype null; normaliza para JSON. */
export function plain(row) {
  return row ? { ...row } : row;
}

let txDepth = 0;

/** Transação reentrante: chamadas aninhadas viram SAVEPOINT. */
export function transaction(fn) {
  const instance = getDb();
  const depth = txDepth++;
  const savepoint = `sp_${depth}`;
  instance.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
  try {
    const result = fn();
    instance.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
    return result;
  } catch (err) {
    try {
      instance.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    } catch { /* já revertido */ }
    throw err;
  } finally {
    txDepth = depth;
  }
}

/* ------------------------------------------------------------------ *
 * Settings                                                            *
 * ------------------------------------------------------------------ */

export function getSettings() {
  const rows = all('SELECT key, value FROM settings');
  const out = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    try { out[row.key] = JSON.parse(row.value); } catch { out[row.key] = row.value; }
  }
  return out;
}

export function getSetting(key) {
  return getSettings()[key];
}

export function setSettings(patch) {
  const stmt = getDb().prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const [key, value] of Object.entries(patch)) {
    stmt.run(key, JSON.stringify(value === undefined ? null : value));
  }
  return getSettings();
}

export function audit(userId, action, entity, entityId, data) {
  run(
    'INSERT INTO audit_log(user_id, action, entity, entity_id, data) VALUES (?,?,?,?,?)',
    userId ?? null,
    action,
    entity ?? null,
    entityId == null ? null : String(entityId),
    data ? JSON.stringify(data) : null
  );
}
