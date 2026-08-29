import { getSettings } from '../db.js';
import { formatBRL } from '../lib/money.js';
import { formatPhone } from '../lib/validate.js';
import { getOrder } from './orders.js';
import { getRoute } from './dispatch.js';
import { notFound } from '../lib/http.js';

const pad = (text, width) => String(text ?? '').padEnd(width).slice(0, width);
const money = (cents) => formatBRL(cents);

function width(settings) {
  return settings.printer_width === '58' ? 32 : 48;
}

function line(char, settings) {
  return char.repeat(width(settings));
}

function twoCols(left, right, settings) {
  const w = width(settings);
  const r = String(right);
  return pad(left, Math.max(0, w - r.length)) + r;
}

/** Comanda de produção (cozinha) — só o que a cozinha precisa ver. */
export function kitchenTicket(orderId) {
  const order = getOrder(orderId);
  if (!order) throw notFound('Pedido não encontrado');
  const s = getSettings();
  const out = [];
  out.push(center('*** COZINHA ***', s));
  out.push(center(`PEDIDO ${order.code}`, s));
  out.push(line('=', s));
  out.push(`Tipo: ${order.type.toUpperCase()}   ${new Date(order.created_at + 'Z').toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`);
  out.push(`Cliente: ${order.customer_name}`);
  if (order.type === 'entrega') out.push(`Bairro: ${order.district || '-'}`);
  out.push(line('-', s));
  for (const item of order.items) {
    out.push(`${formatQty(item.qty)}x ${item.name}`);
    for (const option of item.options || []) out.push(`   + ${option.name}`);
    if (item.notes) out.push(`   OBS: ${item.notes}`);
  }
  if (order.notes) { out.push(line('-', s)); out.push(`OBSERVACAO: ${order.notes}`); }
  out.push(line('=', s));
  out.push(center(`Prometido: ${order.promised_at ? new Date(order.promised_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '-'}`, s));
  if (order.type === 'entrega') out.push(center('Entregador: leia o QR para pegar este pedido', s));
  return out.join('\n');
}

/** Cupom do cliente. */
export function customerReceipt(orderId) {
  const order = getOrder(orderId);
  if (!order) throw notFound('Pedido não encontrado');
  const s = getSettings();
  const out = [];
  out.push(center(s.store_name || 'Outfood', s));
  if (s.store_address) out.push(center(s.store_address, s));
  if (s.store_phone) out.push(center(formatPhone(s.store_phone), s));
  out.push(line('=', s));
  out.push(`Pedido: ${order.code}`);
  out.push(`Data: ${new Date(order.created_at + 'Z').toLocaleString('pt-BR')}`);
  out.push(`Cliente: ${order.customer_name}`);
  if (order.customer_phone) out.push(`Fone: ${formatPhone(order.customer_phone)}`);
  if (order.address) out.push(`Endereco: ${order.address}`);
  if (order.reference) out.push(`Ref.: ${order.reference}`);
  out.push(line('-', s));
  for (const item of order.items) {
    out.push(twoCols(`${formatQty(item.qty)}x ${item.name}`, money(item.total_cents), s));
    for (const option of item.options || []) out.push(`   + ${option.name}`);
  }
  out.push(line('-', s));
  out.push(twoCols('Subtotal', money(order.subtotal_cents), s));
  if (order.delivery_fee_cents) out.push(twoCols('Taxa de entrega', money(order.delivery_fee_cents), s));
  if (order.discount_cents) out.push(twoCols('Desconto', '-' + money(order.discount_cents), s));
  if (order.surcharge_cents) out.push(twoCols('Acrescimo', money(order.surcharge_cents), s));
  out.push(twoCols('TOTAL', money(order.total_cents), s));
  out.push(line('-', s));
  out.push(`Pagamento: ${(order.payment_method || 'a combinar').toUpperCase()}${order.paid ? ' (PAGO)' : ''}`);
  if (order.change_for_cents) {
    out.push(twoCols('Troco para', money(order.change_for_cents), s));
    out.push(twoCols('Levar troco de', money(Math.max(0, order.change_for_cents - order.total_cents)), s));
  }
  if (s.pix_key) out.push(`PIX: ${s.pix_key}`);
  out.push(line('=', s));
  out.push(center('Obrigado pela preferencia!', s));
  out.push(center('Acompanhe seu pedido pelo QR abaixo', s));
  out.push(center(`/r/${order.public_token}`, s));
  return out.join('\n');
}

/** Romaneio do entregador: sequência de paradas, valores a receber e link do mapa. */
export function routeManifest(routeId) {
  const route = getRoute(routeId);
  if (!route) throw notFound('Rota não encontrada');
  const s = getSettings();
  const out = [];
  out.push(center('ROMANEIO DE ENTREGA', s));
  out.push(center(`${s.store_name || 'Outfood'} - Rota #${route.id}`, s));
  out.push(line('=', s));
  out.push(`Entregador: ${route.driver_name}`);
  out.push(`Paradas: ${route.stops.length}   ${route.planned_km.toFixed(1)} km   ~${route.planned_minutes} min`);
  out.push(`Saida: ${new Date().toLocaleString('pt-BR')}`);
  out.push(line('=', s));
  for (const stop of route.stops) {
    out.push(`[${String(stop.seq).padStart(2, '0')}] ${stop.code} - ${stop.customer_name}`);
    out.push(`     ${stop.address}`);
    if (stop.complement) out.push(`     Compl.: ${stop.complement}`);
    if (stop.reference) out.push(`     Ref.: ${stop.reference}`);
    if (stop.customer_phone) out.push(`     Fone: ${formatPhone(stop.customer_phone)}`);
    out.push(`     ${stop.paid ? 'PAGO' : 'RECEBER ' + money(stop.total_cents)} (${(stop.payment_method || '-').toUpperCase()})`);
    if (!stop.paid && stop.change_for_cents) {
      out.push(`     Troco para ${money(stop.change_for_cents)} = ${money(Math.max(0, stop.change_for_cents - stop.total_cents))}`);
    }
    if (stop.notes) out.push(`     OBS: ${stop.notes}`);
    out.push(line('-', s));
  }
  out.push(twoCols('TOTAL A RECEBER', money(route.cash_to_collect_cents), s));
  out.push(line('=', s));
  out.push('Assinatura: ____________________________');
  return out.join('\n');
}

function center(text, settings) {
  const w = width(settings);
  const t = String(text).slice(0, w);
  const left = Math.max(0, Math.floor((w - t.length) / 2));
  return ' '.repeat(left) + t;
}

function formatQty(qty) {
  const n = Number(qty) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace('.', ',');
}
