-- Outfood 2.0 — esquema do banco (SQLite)
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'atendente',
  phone         TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL UNIQUE,
  email      TEXT,
  notes      TEXT,
  blocked    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);

CREATE TABLE IF NOT EXISTS addresses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label       TEXT,
  street      TEXT NOT NULL,
  number      TEXT,
  complement  TEXT,
  district    TEXT,
  city        TEXT,
  state       TEXT,
  zip         TEXT,
  reference   TEXT,
  lat         REAL,
  lon         REAL,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_addresses_customer ON addresses(customer_id);

CREATE TABLE IF NOT EXISTS categories (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL,
  sort   INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  price_cents   INTEGER NOT NULL DEFAULT 0,
  cost_cents    INTEGER NOT NULL DEFAULT 0,
  sku           TEXT,
  prep_minutes  INTEGER NOT NULL DEFAULT 10,
  stock_control INTEGER NOT NULL DEFAULT 0,
  stock_qty     INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  sort          INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);

CREATE TABLE IF NOT EXISTS product_options (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  group_name  TEXT NOT NULL DEFAULT 'Adicionais',
  name        TEXT NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_options_product ON product_options(product_id);

CREATE TABLE IF NOT EXISTS zones (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  color          TEXT NOT NULL DEFAULT '#2E7D32',
  lat            REAL,
  lon            REAL,
  radius_km      REAL NOT NULL DEFAULT 3,
  fee_cents      INTEGER NOT NULL DEFAULT 0,
  min_order_cents INTEGER NOT NULL DEFAULT 0,
  driver_id      INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS drivers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  phone             TEXT,
  vehicle           TEXT NOT NULL DEFAULT 'moto',
  plate             TEXT,
  status            TEXT NOT NULL DEFAULT 'offline',
  commission_type   TEXT NOT NULL DEFAULT 'por_entrega',
  commission_value  INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1,
  lat               REAL,
  lon               REAL,
  last_ping         TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  code               TEXT NOT NULL UNIQUE,
  public_token       TEXT NOT NULL UNIQUE,
  business_day       TEXT NOT NULL,
  customer_id        INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_name      TEXT NOT NULL,
  customer_phone     TEXT,
  channel            TEXT NOT NULL DEFAULT 'balcao',
  type               TEXT NOT NULL DEFAULT 'entrega',
  courier            TEXT NOT NULL DEFAULT 'loja',
  status             TEXT NOT NULL DEFAULT 'recebido',
  platform_name      TEXT,
  platform_code      TEXT,
  street             TEXT,
  number             TEXT,
  complement         TEXT,
  district           TEXT,
  city               TEXT,
  reference          TEXT,
  lat                REAL,
  lon                REAL,
  zone_id            INTEGER REFERENCES zones(id) ON DELETE SET NULL,
  distance_km        REAL,
  subtotal_cents     INTEGER NOT NULL DEFAULT 0,
  delivery_fee_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents     INTEGER NOT NULL DEFAULT 0,
  surcharge_cents    INTEGER NOT NULL DEFAULT 0,
  total_cents        INTEGER NOT NULL DEFAULT 0,
  paid               INTEGER NOT NULL DEFAULT 0,
  payment_method     TEXT,
  change_for_cents   INTEGER NOT NULL DEFAULT 0,
  notes              TEXT,
  prep_minutes       INTEGER NOT NULL DEFAULT 0,
  promised_at        TEXT,
  scheduled_for      TEXT,
  driver_id          INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
  route_id           INTEGER REFERENCES routes(id) ON DELETE SET NULL,
  created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancel_reason      TEXT,
  rating             INTEGER,
  rating_comment     TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at       TEXT,
  ready_at           TEXT,
  dispatched_at      TEXT,
  delivered_at       TEXT,
  cancelled_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_day ON orders(business_day);
CREATE INDEX IF NOT EXISTS idx_orders_driver ON orders(driver_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_route ON orders(route_id);

CREATE TABLE IF NOT EXISTS order_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id       INTEGER REFERENCES products(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  qty              REAL NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  total_cents      INTEGER NOT NULL DEFAULT 0,
  notes            TEXT,
  options_json     TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS order_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  message     TEXT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id);

CREATE TABLE IF NOT EXISTS payments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method         TEXT NOT NULL,
  amount_cents   INTEGER NOT NULL DEFAULT 0,
  received_cents INTEGER NOT NULL DEFAULT 0,
  change_cents   INTEGER NOT NULL DEFAULT 0,
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);

CREATE TABLE IF NOT EXISTS routes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id       INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'planejada',
  planned_km      REAL NOT NULL DEFAULT 0,
  planned_minutes INTEGER NOT NULL DEFAULT 0,
  business_day    TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_routes_driver ON routes(driver_id);
CREATE INDEX IF NOT EXISTS idx_routes_day ON routes(business_day);

CREATE TABLE IF NOT EXISTS route_stops (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id       INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  order_id       INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pendente',
  leg_km         REAL NOT NULL DEFAULT 0,
  delivered_at   TEXT,
  failure_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_stops_route ON route_stops(route_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stops_order ON route_stops(order_id, route_id);

CREATE TABLE IF NOT EXISTS cash_sessions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  business_day        TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'aberto',
  opening_float_cents INTEGER NOT NULL DEFAULT 0,
  counted_cents       INTEGER NOT NULL DEFAULT 0,
  expected_cents      INTEGER NOT NULL DEFAULT 0,
  difference_cents    INTEGER NOT NULL DEFAULT 0,
  notes               TEXT,
  opened_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  closed_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  opened_at           TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at           TEXT
);

CREATE TABLE IF NOT EXISTS geo_cache (
  query      TEXT PRIMARY KEY,
  lat        REAL,
  lon        REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  data       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
