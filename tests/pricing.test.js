import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, seedBasics } from './helpers.js';
import { calcDeliveryFee, driverCommissionCents, itemTotal, totalizeOrder } from '../server/services/pricing.js';
import { formatBRL, percentOf, toCents } from '../server/lib/money.js';
import { getSettings, setSettings } from '../server/db.js';

test('toCents entende os formatos que o usuário digita', () => {
  assert.equal(toCents('12,50'), 1250);
  assert.equal(toCents('R$ 1.234,50'), 123450);
  assert.equal(toCents(12.5), 1250);
  assert.equal(toCents(''), 0);
  assert.equal(toCents('abc'), 0);
});

test('formatBRL e percentOf trabalham em centavos', () => {
  assert.equal(formatBRL(123450).replace(/ /g, ' '), 'R$ 1.234,50');
  assert.equal(percentOf(10000, 12.5), 1250);
});

test('itemTotal soma adicionais antes de multiplicar pela quantidade', () => {
  const item = { qty: 2, unit_price_cents: 5200, options: [{ price_cents: 900 }, { price_cents: 100 }] };
  assert.equal(itemTotal(item), (5200 + 1000) * 2);
});

test('totalizeOrder aplica taxa, desconto e acréscimo sem ficar negativo', () => {
  const items = [{ qty: 1, unit_price_cents: 5000, options: [] }];
  const totals = totalizeOrder({ items, deliveryFeeCents: 500, discountCents: 200, surchargeCents: 100 });
  assert.deepEqual(totals, {
    subtotal_cents: 5000, delivery_fee_cents: 500, discount_cents: 200,
    surcharge_cents: 100, total_cents: 5400,
  });
  const zeroed = totalizeOrder({ items, deliveryFeeCents: 0, discountCents: 999999 });
  assert.equal(zeroed.total_cents, 0, 'desconto maior que o pedido não gera total negativo');
});

test('taxa por zona usa a zona que contém o endereço', () => {
  freshDb();
  seedBasics();
  const settings = getSettings();
  const inZone = calcDeliveryFee({ settings, point: { lat: -22.8243, lon: -43.3998 }, subtotalCents: 5000 });
  assert.equal(inZone.fee_cents, 600);
  assert.equal(inZone.source, 'zona');

  const outside = calcDeliveryFee({ settings, point: { lat: -23.5, lon: -46.6 }, subtotalCents: 5000 });
  assert.equal(outside.fee_cents, 500, 'fora das zonas cai na taxa padrão');
  assert.equal(outside.source, 'padrao');
});

test('taxa por km cresce com a distância', () => {
  freshDb();
  setSettings({ fee_mode: 'km', default_fee_cents: 300, fee_per_km_cents: 150 });
  const settings = getSettings();
  const near = calcDeliveryFee({ settings, point: { lat: -22.8243, lon: -43.3998 }, subtotalCents: 5000 });
  const far = calcDeliveryFee({ settings, point: { lat: -22.9000, lon: -43.4500 }, subtotalCents: 5000 });
  assert.ok(far.fee_cents > near.fee_cents);
  assert.equal(near.source, 'km');
});

test('frete grátis acima do valor configurado zera a taxa', () => {
  freshDb();
  seedBasics();
  setSettings({ free_delivery_above_cents: 10000 });
  const settings = getSettings();
  const below = calcDeliveryFee({ settings, point: { lat: -22.8243, lon: -43.3998 }, subtotalCents: 9999 });
  const above = calcDeliveryFee({ settings, point: { lat: -22.8243, lon: -43.3998 }, subtotalCents: 10000 });
  assert.equal(below.fee_cents, 600);
  assert.equal(above.fee_cents, 0);
  assert.equal(above.source, 'frete_gratis');
});

test('taxa informada manualmente tem prioridade sobre a política', () => {
  freshDb();
  seedBasics();
  const fee = calcDeliveryFee({ settings: getSettings(), point: { lat: -22.8243, lon: -43.3998 }, subtotalCents: 5000, override: 1234 });
  assert.equal(fee.fee_cents, 1234);
  assert.equal(fee.source, 'manual');
});

test('comissão do entregador respeita cada modelo de pagamento', () => {
  const order = { total_cents: 10000, delivery_fee_cents: 600 };
  assert.equal(driverCommissionCents({ commission_type: 'por_entrega', commission_value: 400 }, order), 400);
  assert.equal(driverCommissionCents({ commission_type: 'percentual_taxa', commission_value: 50 }, order), 300);
  assert.equal(driverCommissionCents({ commission_type: 'percentual_pedido', commission_value: 10 }, order), 1000);
  assert.equal(driverCommissionCents({ commission_type: 'diaria', commission_value: 8000 }, order), 0,
    'diária não é paga por entrega');
  assert.equal(driverCommissionCents(null, order), 0);
});
