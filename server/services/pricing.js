import { all } from '../db.js';
import { findZone, haversine } from '../lib/geo.js';

/** Calcula a taxa de entrega conforme a política configurada. */
export function calcDeliveryFee({ settings, point, subtotalCents, zones = null, override = null }) {
  if (override != null && override !== '') return { fee_cents: Math.max(0, Math.round(override)), zone: null, source: 'manual' };

  const freeAbove = Number(settings.free_delivery_above_cents) || 0;
  if (freeAbove > 0 && subtotalCents >= freeAbove) {
    return { fee_cents: 0, zone: null, source: 'frete_gratis' };
  }

  const mode = settings.fee_mode || 'zona';
  const store = storePoint(settings);

  if (mode === 'fixo') {
    return { fee_cents: Number(settings.default_fee_cents) || 0, zone: null, source: 'fixo' };
  }

  if (mode === 'km') {
    const km = point && store ? haversine(store, point) : null;
    if (km == null) return { fee_cents: Number(settings.default_fee_cents) || 0, zone: null, source: 'padrao' };
    const perKm = Number(settings.fee_per_km_cents) || 0;
    const base = Number(settings.default_fee_cents) || 0;
    return { fee_cents: Math.max(0, Math.round(base + km * perKm)), zone: null, source: 'km', km: Math.round(km * 100) / 100 };
  }

  const zoneList = zones || all('SELECT * FROM zones WHERE active = 1');
  const zone = findZone(point, zoneList);
  if (zone) return { fee_cents: Number(zone.fee_cents) || 0, zone, source: 'zona' };
  return { fee_cents: Number(settings.default_fee_cents) || 0, zone: null, source: 'padrao' };
}

export function storePoint(settings) {
  if (settings.store_lat == null || settings.store_lon == null) return null;
  return { lat: Number(settings.store_lat), lon: Number(settings.store_lon) };
}

/** Soma os itens (produto + adicionais) já em centavos. */
export function itemTotal(item) {
  const options = Array.isArray(item.options) ? item.options : [];
  const optionsCents = options.reduce((acc, o) => acc + (Number(o.price_cents) || 0), 0);
  const unit = (Number(item.unit_price_cents) || 0) + optionsCents;
  return Math.round(unit * (Number(item.qty) || 0));
}

/** Totaliza um pedido: subtotal, taxa, desconto, acréscimo e total. */
export function totalizeOrder({ items, deliveryFeeCents = 0, discountCents = 0, surchargeCents = 0 }) {
  const subtotal = items.reduce((acc, item) => acc + itemTotal(item), 0);
  const fee = Math.max(0, Math.round(Number(deliveryFeeCents) || 0));
  const discount = Math.max(0, Math.round(Number(discountCents) || 0));
  const surcharge = Math.max(0, Math.round(Number(surchargeCents) || 0));
  const total = Math.max(0, subtotal + fee + surcharge - discount);
  return { subtotal_cents: subtotal, delivery_fee_cents: fee, discount_cents: discount, surcharge_cents: surcharge, total_cents: total };
}

/** Comissão do entregador por entrega concluída. */
export function driverCommissionCents(driver, order) {
  if (!driver) return 0;
  const value = Number(driver.commission_value) || 0;
  switch (driver.commission_type) {
    case 'percentual_taxa':
      return Math.round(((Number(order?.delivery_fee_cents) || 0) * value) / 100);
    case 'percentual_pedido':
      return Math.round(((Number(order?.total_cents) || 0) * value) / 100);
    case 'diaria':
      return 0; // pago por jornada, não por entrega
    case 'por_entrega':
    default:
      return value;
  }
}
