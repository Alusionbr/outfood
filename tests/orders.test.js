import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, orderInput, seedBasics } from './helpers.js';
import { all, get, getSettings, setSettings } from '../server/db.js';
import {
  addPayment, canTransition, changeStatus, createOrder, getOrder, kitchenQueue,
  listOrders, nextStatuses, rateOrder, updateOrder,
} from '../server/services/orders.js';

function setup() {
  freshDb();
  return seedBasics();
}

test('createOrder congela preço, calcula totais e abre a linha do tempo', () => {
  const { user, pizzaId, optionId } = setup();
  const order = createOrder({
    ...orderInput(0, { productId: pizzaId }),
    items: [{ product_id: pizzaId, qty: 2, options: [{ id: optionId, name: 'Catupiry', price_cents: 900 }] }],
  }, user);

  assert.equal(order.status, 'recebido');
  assert.equal(order.subtotal_cents, (5200 + 900) * 2);
  assert.equal(order.delivery_fee_cents, 600, 'endereço dentro da zona Centro');
  assert.equal(order.total_cents, order.subtotal_cents + 600);
  assert.match(order.code, /^\d{4}-\d{3}$/);
  assert.ok(order.public_token.length > 8);
  assert.equal(order.items[0].options.length, 1);
  assert.equal(order.timeline.length, 1);
  assert.equal(order.prep_minutes, 25, 'usa o preparo do produto mais demorado');
});

test("o preço do pedido não muda quando o cardápio muda depois", async () => {
  const { user, pizzaId } = setup();
  const order = createOrder(orderInput(0, { productId: pizzaId }), user);
  const before = order.total_cents;
  getSettings();
  // O dono aumenta o preço da pizza no dia seguinte.
  const db = get('SELECT id FROM products WHERE id = ?', pizzaId);
  assert.ok(db);
  const { run } = await import('../server/db.js');
  run('UPDATE products SET price_cents = 9900 WHERE id = ?', pizzaId);
  assert.equal(getOrder(order.id).total_cents, before, 'pedido já lançado mantém o valor cobrado');
});

test('cada pedido recebe um código sequencial do dia', () => {
  const { user, pizzaId } = setup();
  const a = createOrder(orderInput(0, { productId: pizzaId }), user);
  const b = createOrder(orderInput(1, { productId: pizzaId }), user);
  assert.notEqual(a.code, b.code);
  assert.equal(Number(b.code.split('-')[1]), Number(a.code.split('-')[1]) + 1);
});

test('pedido de entrega exige itens válidos', () => {
  const { user } = setup();
  assert.throws(() => createOrder({ ...orderInput(0), items: [] }, user), /ao menos um item/i);
  assert.throws(() => createOrder({ ...orderInput(0), items: [{ product_id: 9999, qty: 1 }] }, user), /não existe/i);
  assert.throws(() => createOrder({ ...orderInput(0), items: [{ product_id: 1, qty: 0 }] }, user), /Quantidade inválida/i);
});

test('produto inativo não pode ser vendido', async () => {
  const { user, pizzaId } = setup();
  const { run } = await import('../server/db.js');
  run('UPDATE products SET active = 0 WHERE id = ?', pizzaId);
  assert.throws(() => createOrder(orderInput(0, { productId: pizzaId }), user), /inativo/i);
});

test('pedido mínimo bloqueia entregas abaixo do valor', () => {
  const { user, sodaId } = setup();
  setSettings({ min_order_cents: 5000 });
  assert.throws(() => createOrder(orderInput(0, { productId: sodaId }), user), /mínimo/i);
});

test('a máquina de estados só aceita as transições válidas', () => {
  const { user, pizzaId } = setup();
  const order = createOrder(orderInput(0, { productId: pizzaId }), user);

  assert.throws(() => changeStatus(order.id, 'entregue', user), /Não é possível mudar/);
  assert.throws(() => changeStatus(order.id, 'em_entrega', user), /Não é possível mudar/);

  assert.equal(changeStatus(order.id, 'em_preparo', user).status, 'em_preparo');
  const ready = changeStatus(order.id, 'pronto', user);
  assert.equal(ready.status, 'pronto');
  assert.ok(ready.ready_at, 'a hora de "pronto" fica registrada');

  // Entrega própria: precisa passar pelo entregador antes de "entregue".
  assert.deepEqual(nextStatuses(ready), ['em_entrega', 'cancelado']);
  assert.throws(() => changeStatus(order.id, 'em_entrega', user), /Defina o entregador/);
});

test('retirada no balcão vai de pronto direto para entregue', () => {
  const { user, pizzaId } = setup();
  const order = createOrder({ ...orderInput(0, { productId: pizzaId }), type: 'retirada' }, user);
  assert.equal(order.delivery_fee_cents, 0, 'retirada não tem taxa');
  changeStatus(order.id, 'em_preparo', user);
  changeStatus(order.id, 'pronto', user);
  const done = changeStatus(order.id, 'entregue', user);
  assert.equal(done.status, 'entregue');
  assert.ok(done.delivered_at);
});

test('pedido entregue ou cancelado não pode mais ser editado', () => {
  const { user, pizzaId } = setup();
  const order = createOrder({ ...orderInput(0, { productId: pizzaId }), type: 'retirada' }, user);
  changeStatus(order.id, 'pronto', user);
  changeStatus(order.id, 'entregue', user);
  assert.throws(() => updateOrder(order.id, { notes: 'tarde demais' }, user), /não pode ser editado/i);
  assert.throws(() => changeStatus(order.id, 'em_preparo', user), /Não é possível mudar/);
});

test('cancelamento guarda o motivo e devolve o estoque', async () => {
  const { user, pizzaId } = setup();
  const { run } = await import('../server/db.js');
  run('UPDATE products SET stock_control = 1, stock_qty = 10 WHERE id = ?', pizzaId);

  const order = createOrder({ ...orderInput(0), items: [{ product_id: pizzaId, qty: 3 }] }, user);
  assert.equal(get('SELECT stock_qty FROM products WHERE id = ?', pizzaId).stock_qty, 7, 'baixa no estoque ao vender');

  const cancelled = changeStatus(order.id, 'cancelado', user, { reason: 'Cliente desistiu' });
  assert.equal(cancelled.status, 'cancelado');
  assert.equal(cancelled.cancel_reason, 'Cliente desistiu');
  assert.equal(get('SELECT stock_qty FROM products WHERE id = ?', pizzaId).stock_qty, 10, 'estorna o estoque');
});

test('updateOrder recalcula os totais ao trocar os itens', () => {
  const { user, pizzaId, sodaId } = setup();
  const order = createOrder({ ...orderInput(0), items: [{ product_id: pizzaId, qty: 1 }] }, user);
  const updated = updateOrder(order.id, { items: [{ product_id: sodaId, qty: 3 }] }, user);
  assert.equal(updated.subtotal_cents, 2100);
  assert.equal(updated.total_cents, 2100 + updated.delivery_fee_cents);
  assert.equal(updated.items.length, 1);
});

test('pagamentos parciais só marcam o pedido como pago ao cobrir o total', () => {
  const { user, pizzaId } = setup();
  const order = createOrder({ ...orderInput(0), items: [{ product_id: pizzaId, qty: 1 }] }, user);
  const half = Math.floor(order.total_cents / 2);

  const partial = addPayment(order.id, { method: 'pix', amount_cents: half }, user);
  assert.equal(partial.paid, false);

  const full = addPayment(order.id, { method: 'dinheiro', amount_cents: order.total_cents - half, received_cents: 10000 }, user);
  assert.equal(full.paid, true);
  assert.equal(full.payments.length, 2);
  assert.ok(full.payments[1].change_cents > 0, 'o troco é calculado a partir do valor recebido');
  assert.throws(() => addPayment(order.id, { method: 'pix', amount_cents: 0 }, user), /maior que zero/i);
});

test('a fila da cozinha mostra só o que está em produção e marca os atrasados', async () => {
  const { user, pizzaId } = setup();
  const a = createOrder(orderInput(0, { productId: pizzaId }), user);
  const b = createOrder({ ...orderInput(1), type: 'retirada' }, user);
  changeStatus(b.id, 'em_preparo', user);
  changeStatus(b.id, 'pronto', user);
  changeStatus(b.id, 'entregue', user);

  const queue = kitchenQueue();
  assert.equal(queue.length, 1, 'entregue sai da fila da cozinha');
  assert.equal(queue[0].id, a.id);
  assert.equal(queue[0].late, false);

  const { run } = await import('../server/db.js');
  run("UPDATE orders SET promised_at = datetime('now','-30 minutes') WHERE id = ?", a.id);
  assert.equal(kitchenQueue()[0].late, true, 'passou da promessa e ainda não está pronto');
});

test('listOrders filtra por status, tipo e busca livre', () => {
  const { user, pizzaId } = setup();
  createOrder({ ...orderInput(0, { productId: pizzaId }), customer_name: 'Ana Paula' }, user);
  const pickup = createOrder({ ...orderInput(1, { productId: pizzaId }), type: 'retirada', customer_name: 'Bruno' }, user);
  changeStatus(pickup.id, 'em_preparo', user);

  assert.equal(listOrders({ type: 'retirada' }).length, 1);
  assert.equal(listOrders({ status: 'em_preparo' }).length, 1);
  assert.equal(listOrders({ open: true }).length, 2);
  assert.equal(listOrders({ q: 'Ana' }).length, 1);
  assert.equal(listOrders({ q: 'ninguém' }).length, 0);
});

test('a avaliação do cliente só abre depois da entrega', () => {
  const { user, pizzaId } = setup();
  const order = createOrder({ ...orderInput(0, { productId: pizzaId }), type: 'retirada' }, user);
  assert.throws(() => rateOrder(order.public_token, 5), /após a entrega/i);

  changeStatus(order.id, 'pronto', user);
  changeStatus(order.id, 'entregue', user);
  assert.equal(rateOrder(order.public_token, 5, 'Chegou quente!').rating, 5);
  assert.equal(getOrder(order.id).rating, 5);
  assert.equal(rateOrder(order.public_token, 9).rating, 5, 'nota fica no intervalo de 1 a 5');
});
