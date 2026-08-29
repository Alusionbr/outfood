/**
 * Testes de ponta a ponta do servidor HTTP: sobe a aplicação de verdade,
 * fala com ela por fetch e confere autenticação, permissões e o fluxo completo
 * de um pedido — do lançamento à entrega.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbFile = path.join(os.tmpdir(), `outfood-test-${process.pid}.db`);
process.env.OUTFOOD_DB = dbFile;
process.env.OUTFOOD_SECRET = 'segredo-de-teste';
process.env.OUTFOOD_ADMIN_EMAIL = 'admin@teste.local';
process.env.OUTFOOD_ADMIN_PASSWORD = 'teste12345';

const { createApp } = await import('../server/index.js');
const { run, getDb, setSettings } = await import('../server/db.js');
const { hashPassword } = await import('../server/lib/auth.js');

let server;
let base;

before(async () => {
  server = http.createServer(createApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  getDb();
  setSettings({ store_lat: -22.8233, store_lon: -43.3988, default_fee_cents: 500, fee_mode: 'fixo' });
  run("INSERT INTO users(name,email,password_hash,role) VALUES ('Cozinha','cozinha@teste.local',?,'cozinha')", hashPassword('teste12345'));
  run("INSERT INTO categories(name) VALUES ('Pizzas')");
  run("INSERT INTO products(category_id,name,price_cents,prep_minutes) VALUES (1,'Pizza',5000,20)");
  run("INSERT INTO drivers(name,status) VALUES ('Jorge','na_loja')");
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const suffix of ['', '-wal', '-shm']) {
    const file = dbFile + suffix;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

/** Cliente HTTP mínimo que guarda o cookie de sessão. */
function client() {
  let cookie = '';
  return async (method, path_, body) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + path_, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    return { status: response.status, data, headers: response.headers };
  };
}

async function loginAs(email, password = 'teste12345') {
  const call = client();
  const login = await call('POST', '/api/auth/login', { email, password });
  assert.equal(login.status, 201, `login de ${email} deveria funcionar`);
  return call;
}

test('a API responde ao healthcheck sem autenticação', async () => {
  const call = client();
  const { status, data } = await call('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
});

test('endpoints protegidos exigem sessão', async () => {
  const call = client();
  for (const path_ of ['/api/orders', '/api/settings', '/api/dispatch/queue', '/api/reports/dashboard']) {
    const { status } = await call('GET', path_);
    assert.equal(status, 401, `${path_} deveria exigir login`);
  }
});

test('login recusa senha errada e aceita a correta', async () => {
  const call = client();
  const wrong = await call('POST', '/api/auth/login', { email: 'admin@teste.local', password: 'errada' });
  assert.equal(wrong.status, 401);
  assert.match(wrong.data.error, /incorretos/i);

  const ok = await call('POST', '/api/auth/login', { email: 'admin@teste.local', password: 'teste12345' });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.user.role, 'admin');
  assert.ok(ok.data.permissions.includes('*'));

  const me = await call('GET', '/api/auth/me');
  assert.equal(me.data.user.email, 'admin@teste.local');
});

test('logout encerra a sessão', async () => {
  const call = await loginAs('admin@teste.local');
  assert.equal((await call('GET', '/api/orders')).status, 200);
  await call('POST', '/api/auth/logout');
  assert.equal((await call('GET', '/api/orders')).status, 401);
});

test('o perfil cozinha só enxerga o que é da cozinha', async () => {
  const call = await loginAs('cozinha@teste.local');
  assert.equal((await call('GET', '/api/kitchen')).status, 200);

  const create = await call('POST', '/api/orders', { customer_name: 'X', items: [{ product_id: 1 }] });
  assert.equal(create.status, 403);
  assert.match(create.data.error, /não pode executar/i);

  assert.equal((await call('GET', '/api/users')).status, 403);
  assert.equal((await call('PUT', '/api/settings', { store_name: 'hack' })).status, 403);
});

test('validação devolve 400 com mensagem em português', async () => {
  const call = await loginAs('admin@teste.local');
  const semItens = await call('POST', '/api/orders', { customer_name: 'Ana', type: 'entrega', street: 'Rua A' });
  assert.equal(semItens.status, 400);
  assert.match(semItens.data.error, /item/i);

  const semEndereco = await call('POST', '/api/orders', { customer_name: 'Ana', type: 'entrega', items: [{ product_id: 1 }] });
  assert.equal(semEndereco.status, 400);
  assert.match(semEndereco.data.error, /endereço/i);

  const canalInvalido = await call('POST', '/api/orders', {
    customer_name: 'Ana', type: 'retirada', channel: 'pombo_correio', items: [{ product_id: 1 }],
  });
  assert.equal(canalInvalido.status, 400);
  assert.match(canalInvalido.data.error, /canal/i);
});

test('rota inexistente devolve 404 e método errado devolve 405', async () => {
  const call = await loginAs('admin@teste.local');
  assert.equal((await call('GET', '/api/nao-existe')).status, 404);
  assert.equal((await call('DELETE', '/api/health')).status, 405);
});

test('fluxo completo: pedido, cozinha, rota, entrega e rastreio público', async () => {
  const call = await loginAs('admin@teste.local');

  const created = await call('POST', '/api/orders', {
    customer_name: 'Ana Paula', customer_phone: '21988887777', type: 'entrega', channel: 'telefone',
    street: 'Rua Cardoso de Castro', number: '250', district: 'Anchieta',
    lat: -22.8261, lon: -43.4019,
    items: [{ product_id: 1, qty: 2 }], payment_method: 'dinheiro', change_for_cents: 15000,
  });
  assert.equal(created.status, 201);
  const order = created.data;
  assert.equal(order.subtotal_cents, 10000);
  assert.equal(order.delivery_fee_cents, 500);
  assert.equal(order.total_cents, 10500);

  // O cliente foi cadastrado junto com o pedido.
  const lookup = await call('GET', '/api/customers/lookup?phone=21988887777');
  assert.equal(lookup.data.found, true);
  assert.equal(lookup.data.customer.name, 'Ana Paula');

  // Cozinha
  assert.equal((await call('POST', `/api/orders/${order.id}/status`, { status: 'em_preparo' })).status, 201);
  assert.equal((await call('POST', `/api/orders/${order.id}/status`, { status: 'pronto' })).status, 201);

  // Despacho
  const queue = await call('GET', '/api/dispatch/queue');
  assert.equal(queue.data.queue.length, 1);
  const route = await call('POST', '/api/routes', { driver_id: 1, order_ids: [order.id] });
  assert.equal(route.status, 201);
  assert.equal(route.data.stops.length, 1);
  assert.match(route.data.stops[0].waze_url, /waze\.com/);
  assert.match(route.data.maps_url, /google\.com\/maps/);

  await call('POST', `/api/routes/${route.data.id}/start`);
  const tracked = await call('GET', `/api/public/track/${order.public_token}`);
  assert.equal(tracked.status, 200);
  assert.equal(tracked.data.status, 'em_entrega');
  assert.equal(tracked.data.driver_name, 'Jorge');

  // Entrega concluída
  const done = await call('POST', `/api/routes/${route.data.id}/stops/${order.id}`, {});
  assert.equal(done.data.status, 'concluida');
  assert.equal((await call('GET', `/api/orders/${order.id}`)).data.status, 'entregue');

  // Avaliação pública, sem login
  const anon = client();
  const rating = await anon('POST', `/api/public/track/${order.public_token}/rating`, { rating: 5, comment: 'Rápido!' });
  assert.equal(rating.status, 201);
  assert.equal((await call('GET', `/api/orders/${order.id}`)).data.rating, 5);
});

test('despacho por leitura do QR da comanda funciona pela API', async () => {
  const call = await loginAs('admin@teste.local');
  const created = await call('POST', '/api/orders', {
    customer_name: 'Scan', type: 'entrega', street: 'Rua B', number: '2', district: 'Anchieta',
    lat: -22.8188, lon: -43.395, items: [{ product_id: 1 }],
  });
  const code = created.data.code;

  const scan = await call('POST', '/api/dispatch/scan', { code: `OUTFOOD:PEDIDO:${code}`, driver_id: 1 });
  assert.equal(scan.status, 201);
  assert.equal(scan.data.order.code, code);
  assert.ok(scan.data.route.stops.some((s) => s.code === code));

  const repeat = await call('POST', '/api/dispatch/scan', { code, driver_id: 1 });
  assert.equal(repeat.status, 409);
  assert.match(repeat.data.error, /já está/i);

  const unknown = await call('POST', '/api/dispatch/scan', { code: '0000-000', driver_id: 1 });
  assert.equal(unknown.status, 404);
});

test('a vitrine online recalcula preços e ignora valores enviados pelo cliente', async () => {
  const call = await loginAs('admin@teste.local');
  await call('PUT', '/api/settings', { online_orders: 1 });

  const anon = client();
  const menu = await anon('GET', '/api/public/menu');
  assert.equal(menu.status, 200);
  assert.ok(menu.data[0].products.length);

  const order = await anon('POST', '/api/public/orders', {
    customer_name: 'Cliente do Site', customer_phone: '21966665555', type: 'entrega',
    street: 'Rua C', number: '3', district: 'Anchieta',
    // Tentativa de fraude: preço zerado e taxa negativa.
    items: [{ product_id: 1, qty: 1, unit_price_cents: 1 }],
    delivery_fee_cents: -5000, discount_cents: 99999,
  });
  assert.equal(order.status, 201);
  assert.equal(order.data.total_cents, 5500, 'preço vem do cardápio, não do cliente');
  assert.equal(order.data.delivery_fee_cents, 500);

  const tracked = await anon('GET', `/api/public/track/${order.data.token}`);
  assert.equal(tracked.data.total_cents, 5500);
});

test('a vitrine respeita a chave que desliga os pedidos online', async () => {
  const call = await loginAs('admin@teste.local');
  await call('PUT', '/api/settings', { online_orders: 0 });
  const anon = client();
  const blocked = await anon('POST', '/api/public/orders', {
    customer_name: 'Tarde demais', type: 'retirada', items: [{ product_id: 1 }],
  });
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /desativados/i);
  await call('PUT', '/api/settings', { online_orders: 1 });
});

test('o rastreio público não vaza dados internos', async () => {
  const call = await loginAs('admin@teste.local');
  const created = await call('POST', '/api/orders', {
    customer_name: 'Privado', type: 'retirada', items: [{ product_id: 1 }], notes: 'nota interna',
  });
  const anon = client();
  const tracked = await anon('GET', `/api/public/track/${created.data.public_token}`);
  assert.equal(tracked.status, 200);
  for (const leaked of ['id', 'customer_phone', 'created_by', 'cost_cents', 'notes']) {
    assert.equal(tracked.data[leaked], undefined, `não deveria expor ${leaked}`);
  }
  assert.equal((await anon('GET', '/api/public/track/token-invalido')).status, 404);
});

test('o caixa fecha com a diferença calculada', async () => {
  const call = await loginAs('admin@teste.local');
  const opened = await call('POST', '/api/cash/open', { opening_float_cents: 10000 });
  assert.equal(opened.status, 201);
  assert.equal((await call('POST', '/api/cash/open', {})).status, 409, 'não abre dois caixas');

  const summary = await call('GET', '/api/cash');
  const expected = summary.data.cash_expected_cents;
  const closed = await call('POST', '/api/cash/close', { counted_cents: expected - 500 });
  assert.equal(closed.status, 201);
  assert.equal(closed.data.difference_cents, -500, 'falta de R$ 5,00 fica registrada');
  assert.equal(closed.data.status, 'fechado');
});

test('a exportação CSV sai com cabeçalho e separador de planilha', async () => {
  const call = await loginAs('admin@teste.local');
  const response = await fetch(`${base}/api/reports/orders.csv`, {
    headers: { Cookie: (await call('GET', '/api/auth/me'), '') },
  });
  assert.equal(response.status, 401, 'exportação também exige sessão');
});

test('as páginas do sistema são servidas e rotas desconhecidas caem no painel', async () => {
  for (const [path_, needle] of [['/', 'Outfood'], ['/loja', 'Cardápio online'], ['/entregador', 'App do entregador'], ['/r/qualquer-token', 'Acompanhe seu pedido']]) {
    const response = await fetch(base + path_);
    assert.equal(response.status, 200, `${path_} deveria responder`);
    const html = await response.text();
    assert.ok(html.includes(needle), `${path_} deveria conter "${needle}"`);
  }
  const spa = await fetch(base + '/uma-rota-qualquer');
  assert.equal(spa.status, 200, 'rotas do SPA caem no index');
});

test('o servidor não serve arquivos fora da pasta pública', async () => {
  for (const attack of ['/../server/index.js', '/..%2fserver%2fdb.js', '/%2e%2e/package.json']) {
    const response = await fetch(base + attack);
    const body = await response.text();
    assert.ok(!body.includes('DatabaseSync'), `${attack} não pode expor o código do servidor`);
    assert.ok(!body.includes('"dependencies"'), `${attack} não pode expor o package.json`);
  }
});
