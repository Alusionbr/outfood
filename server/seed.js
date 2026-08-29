/**
 * Popula o banco com uma operação de exemplo: cardápio, equipe, zonas,
 * clientes e pedidos do dia. Use `npm run seed` (ou `npm run reset` para
 * apagar tudo antes).
 */
import fs from 'node:fs';
import { config } from './config.js';
import { getDb, all, get, run, setSettings, transaction } from './db.js';
import { hashPassword } from './lib/auth.js';
import { createOrder, changeStatus, businessDay } from './services/orders.js';
import { createRoute, startRoute, completeStop } from './services/dispatch.js';

const reset = process.argv.includes('--reset');

if (reset && fs.existsSync(config.dbPath)) {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = config.dbPath + suffix;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  console.log('[seed] banco anterior removido');
}

getDb();

const STORE = { lat: -22.8233, lon: -43.3988 };

const USERS = [
  { name: 'Administrador', email: config.admin.email, password: config.admin.password, role: 'admin' },
  { name: 'Marina Souza', email: 'gerente@outfood.local', password: 'outfood123', role: 'gerente' },
  { name: 'Rafael Lima', email: 'atendente@outfood.local', password: 'outfood123', role: 'atendente' },
  { name: 'Dona Cida', email: 'cozinha@outfood.local', password: 'outfood123', role: 'cozinha' },
  { name: 'Jorge Motoboy', email: 'jorge@outfood.local', password: 'outfood123', role: 'entregador' },
  { name: 'Paulo Motoboy', email: 'paulo@outfood.local', password: 'outfood123', role: 'entregador' },
];

const MENU = [
  ['Pizzas', [
    ['Pizza Marguerita', 'Molho de tomate, mussarela e manjericão', 4900, 25],
    ['Pizza Calabresa', 'Calabresa fatiada, cebola e azeitona', 5200, 25],
    ['Pizza Quatro Queijos', 'Mussarela, provolone, gorgonzola e parmesão', 5800, 25],
    ['Pizza Frango com Catupiry', 'Frango desfiado e catupiry', 5600, 28],
  ]],
  ['Lanches', [
    ['X-Burguer', 'Pão, hambúrguer 150g, queijo e salada', 2600, 12],
    ['X-Bacon', 'Hambúrguer 150g, bacon crocante e cheddar', 3100, 14],
    ['X-Tudo', 'Dois hambúrgueres, ovo, bacon, presunto e queijo', 3900, 16],
  ]],
  ['Porções', [
    ['Batata Frita Grande', 'Serve 2 pessoas', 2400, 12],
    ['Frango a Passarinho', 'Com alho e limão', 3800, 20],
  ]],
  ['Bebidas', [
    ['Refrigerante Lata', 'Coca, Guaraná ou Fanta 350ml', 700, 1],
    ['Suco Natural 500ml', 'Laranja, limão ou maracujá', 1200, 4],
    ['Água Mineral 500ml', 'Com ou sem gás', 500, 1],
    ['Cerveja Long Neck', 'Gelada', 1100, 1],
  ]],
];

const OPTIONS = {
  'X-Burguer': [['Adicionais', 'Bacon extra', 500], ['Adicionais', 'Ovo', 300], ['Adicionais', 'Cheddar', 400]],
  'X-Bacon': [['Adicionais', 'Bacon extra', 500], ['Adicionais', 'Cebola caramelizada', 400]],
  'Pizza Marguerita': [['Borda', 'Borda de catupiry', 900], ['Borda', 'Borda de cheddar', 900]],
  'Pizza Calabresa': [['Borda', 'Borda de catupiry', 900]],
};

const ZONES = [
  ['Centro / Anchieta', '#2E7D32', -22.8233, -43.3988, 2.5, 400],
  ['Ricardo de Albuquerque', '#E65100', -22.8402, -43.3955, 3, 600],
  ['Guadalupe / Pavuna', '#1565C0', -22.8250, -43.3700, 4, 800],
  ['Nilópolis', '#6A1B9A', -22.8076, -43.4136, 4, 900],
];

const CUSTOMERS = [
  ['Ana Carolina', '21988770011', 'Rua Cardoso de Castro', '250', 'Anchieta', -22.8261, -43.4019],
  ['Bruno Ferreira', '21997654321', 'Rua Japoara', '78', 'Ricardo de Albuquerque', -22.8388, -43.3931],
  ['Carla Mendes', '21996543210', 'Avenida Brasil', '1200', 'Guadalupe', -22.8385, -43.3766],
  ['Diego Santos', '21995432109', 'Estrada Mirandela', '410', 'Nilopolis', -22.8091, -43.4128],
  ['Eduarda Rocha', '21994321098', 'Rua Alcobaca', '35', 'Parque Anchieta', -22.8341, -43.4122],
  ['Fabio Nunes', '21993210987', 'Rua Vitor Meireles', '90', 'Anchieta', -22.8215, -43.3960],
  ['Gabriela Dias', '21992109876', 'Avenida Nazare', '512', 'Parque Anchieta', -22.8360, -43.4140],
  ['Henrique Alves', '21991098765', 'Rua Camboata', '155', 'Ricardo de Albuquerque', -22.8425, -43.3902],
];

function seedUsers() {
  for (const user of USERS) {
    if (get('SELECT id FROM users WHERE email = ?', user.email.toLowerCase())) continue;
    const result = run('INSERT INTO users(name, email, password_hash, role) VALUES (?,?,?,?)',
      user.name, user.email.toLowerCase(), hashPassword(user.password), user.role);
    if (user.role === 'entregador') {
      run("INSERT INTO drivers(user_id, name, phone, vehicle, status, commission_type, commission_value) VALUES (?,?,?,?,?,?,?)",
        Number(result.lastInsertRowid), user.name, '2199' + Math.floor(1000000 + Math.random() * 8999999),
        'moto', 'na_loja', 'por_entrega', 400);
    }
  }
}

function seedMenu() {
  if (get('SELECT COUNT(*) AS total FROM products').total > 0) return;
  MENU.forEach(([categoryName, products], index) => {
    const category = run('INSERT INTO categories(name, sort) VALUES (?,?)', categoryName, index);
    const categoryId = Number(category.lastInsertRowid);
    products.forEach(([name, description, price, prep], sort) => {
      const result = run(
        'INSERT INTO products(category_id, name, description, price_cents, cost_cents, prep_minutes, sort) VALUES (?,?,?,?,?,?,?)',
        categoryId, name, description, price, Math.round(price * 0.38), prep, sort
      );
      for (const [group, optionName, optionPrice] of OPTIONS[name] || []) {
        run('INSERT INTO product_options(product_id, group_name, name, price_cents) VALUES (?,?,?,?)',
          Number(result.lastInsertRowid), group, optionName, optionPrice);
      }
    });
  });
}

function seedZones() {
  if (get('SELECT COUNT(*) AS total FROM zones').total > 0) return;
  for (const [name, color, lat, lon, radius, fee] of ZONES) {
    run('INSERT INTO zones(name, color, lat, lon, radius_km, fee_cents) VALUES (?,?,?,?,?,?)',
      name, color, lat, lon, radius, fee);
  }
}

function seedCustomers() {
  for (const [name, phone, street, number, district, lat, lon] of CUSTOMERS) {
    if (get('SELECT id FROM customers WHERE phone = ?', phone)) continue;
    const result = run('INSERT INTO customers(name, phone) VALUES (?,?)', name, phone);
    run(
      `INSERT INTO addresses(customer_id, label, street, number, district, city, lat, lon, is_default)
       VALUES (?,?,?,?,?,?,?,?,1)`,
      Number(result.lastInsertRowid), 'Casa', street, number, district, 'Rio de Janeiro - RJ', lat, lon
    );
  }
}

function seedOrders() {
  if (get('SELECT COUNT(*) AS total FROM orders WHERE business_day = ?', businessDay()).total > 0) {
    console.log('[seed] já existem pedidos hoje, pulando');
    return;
  }
  const products = all('SELECT * FROM products WHERE active = 1');
  const customers = all('SELECT c.*, a.street, a.number, a.district, a.city, a.lat, a.lon FROM customers c JOIN addresses a ON a.customer_id = c.id');
  const admin = get("SELECT * FROM users WHERE role = 'admin'");
  const channels = ['telefone', 'whatsapp', 'balcao', 'site', 'ifood'];
  const payments = ['dinheiro', 'pix', 'credito', 'debito'];
  const created = [];

  customers.forEach((customer, index) => {
    const itemCount = 1 + (index % 3);
    const items = Array.from({ length: itemCount }, (_, i) => {
      const product = products[(index * 3 + i) % products.length];
      return { product_id: product.id, qty: 1 + ((index + i) % 2) };
    });
    const channel = channels[index % channels.length];
    const order = createOrder({
      customer_id: customer.id,
      customer_name: customer.name,
      customer_phone: customer.phone,
      channel,
      type: index === 5 ? 'retirada' : 'entrega',
      courier: channel === 'ifood' ? 'plataforma' : 'loja',
      platform_name: channel === 'ifood' ? 'iFood' : null,
      street: customer.street, number: customer.number, district: customer.district,
      city: customer.city, lat: customer.lat, lon: customer.lon,
      items,
      payment_method: payments[index % payments.length],
      paid: index % 3 === 0,
      notes: index % 4 === 0 ? 'Sem cebola, por favor.' : null,
    }, admin);
    created.push(order);
  });

  // Fluxo realista: alguns já entregues, alguns em rota, alguns na cozinha.
  created.slice(0, 3).forEach((order) => {
    changeStatus(order.id, 'em_preparo', admin);
    changeStatus(order.id, 'pronto', admin);
  });
  created.slice(3, 5).forEach((order) => changeStatus(order.id, 'em_preparo', admin));

  const driver = get("SELECT * FROM drivers WHERE status = 'na_loja' ORDER BY id LIMIT 1");
  // Recarrega o estado real: os objetos de `created` são anteriores às mudanças acima.
  const routable = created
    .map((order) => get('SELECT * FROM orders WHERE id = ?', order.id))
    .filter((o) => o.type === 'entrega' && o.courier === 'loja' && o.status === 'pronto');
  if (driver && routable.length >= 2) {
    const route = createRoute(driver.id, routable.slice(0, 2).map((o) => o.id), admin);
    startRoute(route.id, admin);
    completeStop(route.id, route.stops[0].order_id, admin);
  }
  console.log(`[seed] ${created.length} pedidos criados`);
}

transaction(() => {
  setSettings({
    store_name: 'Outfood Pizzaria & Lanches',
    store_phone: '2135551234',
    store_address: 'Estrada Marechal Alencastro, 1200 - Anchieta, Rio de Janeiro - RJ',
    store_lat: STORE.lat,
    store_lon: STORE.lon,
    city: 'Rio de Janeiro - RJ',
    delivery_radius_km: 10,
    default_fee_cents: 500,
    fee_mode: 'zona',
    free_delivery_above_cents: 12000,
    avg_speed_kmh: 22,
    stop_minutes: 4,
    default_prep_minutes: 25,
    service_hours: '18:00 às 23:30',
    pix_key: 'contato@outfood.local',
  });
  seedUsers();
  seedMenu();
  seedZones();
  seedCustomers();
  seedOrders();
});

console.log('[seed] pronto.');
console.log(`[seed] acesse com ${config.admin.email} / ${config.admin.password}`);
