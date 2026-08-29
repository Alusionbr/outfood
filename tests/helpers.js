/** Base compartilhada dos testes: banco em memória, dados mínimos e um usuário. */
import { createTestDb, useDatabase, run, get, setSettings } from '../server/db.js';
import { hashPassword } from '../server/lib/auth.js';

export function freshDb() {
  const db = createTestDb();
  useDatabase(db);
  setSettings({
    store_name: 'Teste',
    store_lat: -22.8233,
    store_lon: -43.3988,
    city: 'Rio de Janeiro - RJ',
    default_fee_cents: 500,
    free_delivery_above_cents: 0,
    min_order_cents: 0,
    fee_mode: 'zona',
    avg_speed_kmh: 22,
    stop_minutes: 4,
    default_prep_minutes: 20,
  });
  return db;
}

export function seedBasics() {
  const admin = run("INSERT INTO users(name,email,password_hash,role) VALUES ('Admin','admin@t.local',?,'admin')",
    hashPassword('segredo123'));
  const adminId = Number(admin.lastInsertRowid);
  const category = run("INSERT INTO categories(name) VALUES ('Pizzas')");
  const pizza = run('INSERT INTO products(category_id,name,price_cents,prep_minutes) VALUES (?,?,?,?)',
    Number(category.lastInsertRowid), 'Pizza Calabresa', 5200, 25);
  const soda = run('INSERT INTO products(name,price_cents,prep_minutes) VALUES (?,?,?)', 'Refrigerante', 700, 1);
  const option = run('INSERT INTO product_options(product_id,group_name,name,price_cents) VALUES (?,?,?,?)',
    Number(pizza.lastInsertRowid), 'Borda', 'Catupiry', 900);
  const driver = run("INSERT INTO drivers(name,status,commission_type,commission_value) VALUES ('Jorge','na_loja','por_entrega',400)");
  const driver2 = run("INSERT INTO drivers(name,status,commission_type,commission_value) VALUES ('Paulo','na_loja','por_entrega',400)");
  const zone = run("INSERT INTO zones(name,lat,lon,radius_km,fee_cents) VALUES ('Centro',-22.8233,-43.3988,3,600)");
  return {
    user: get('SELECT * FROM users WHERE id = ?', adminId),
    pizzaId: Number(pizza.lastInsertRowid),
    sodaId: Number(soda.lastInsertRowid),
    optionId: Number(option.lastInsertRowid),
    driverId: Number(driver.lastInsertRowid),
    driver2Id: Number(driver2.lastInsertRowid),
    zoneId: Number(zone.lastInsertRowid),
  };
}

/** Endereços perto da loja de teste, com coordenada. */
export const ADDRESSES = [
  { street: 'Rua A', number: '10', district: 'Centro', lat: -22.8251, lon: -43.4011 },
  { street: 'Rua B', number: '20', district: 'Centro', lat: -22.8188, lon: -43.3950 },
  { street: 'Rua C', number: '30', district: 'Centro', lat: -22.8300, lon: -43.4100 },
  { street: 'Rua D', number: '40', district: 'Centro', lat: -22.8150, lon: -43.3900 },
];

export function orderInput(index, extra = {}) {
  const address = ADDRESSES[index % ADDRESSES.length];
  return {
    customer_name: `Cliente ${index}`,
    customer_phone: `2199000000${index}`,
    type: 'entrega',
    channel: 'telefone',
    items: [{ product_id: extra.productId ?? 1, qty: 1 }],
    ...address,
    ...extra,
  };
}
