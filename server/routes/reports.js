import { Router, notFound, sendText } from '../lib/http.js';
import { requirePermission } from '../lib/auth.js';
import { int, str } from '../lib/validate.js';
import {
  cashSummary, closeCash, currentCashSession, customerRanking, dashboard,
  listCashSessions, openCash, ordersCsv, productRanking, salesSeries,
} from '../services/reports.js';
import { businessDay } from '../services/orders.js';
import { customerReceipt, kitchenTicket, routeManifest } from '../services/print.js';
import { audit } from '../db.js';

export const reportsRouter = new Router();

reportsRouter.get('/api/reports/dashboard', async (ctx) => {
  requirePermission(ctx, 'reports:read');
  return dashboard(ctx.url.searchParams.get('day') || businessDay());
});

reportsRouter.get('/api/reports/sales', async (ctx) => {
  requirePermission(ctx, 'reports:read');
  return salesSeries({ from: ctx.url.searchParams.get('from'), to: ctx.url.searchParams.get('to') });
});

reportsRouter.get('/api/reports/customers', async (ctx) => {
  requirePermission(ctx, 'reports:read');
  return customerRanking({
    from: ctx.url.searchParams.get('from'),
    to: ctx.url.searchParams.get('to'),
    limit: ctx.url.searchParams.get('limit'),
  });
});

reportsRouter.get('/api/reports/products', async (ctx) => {
  requirePermission(ctx, 'reports:read');
  return productRanking({
    from: ctx.url.searchParams.get('from'),
    to: ctx.url.searchParams.get('to'),
    limit: ctx.url.searchParams.get('limit'),
  });
});

reportsRouter.get('/api/reports/orders.csv', async (ctx) => {
  requirePermission(ctx, 'reports:read');
  const csv = ordersCsv({ from: ctx.url.searchParams.get('from'), to: ctx.url.searchParams.get('to') });
  ctx.res.setHeader('Content-Disposition', `attachment; filename="outfood-pedidos-${businessDay()}.csv"`);
  sendText(ctx.res, 200, '﻿' + csv, 'text/csv; charset=utf-8');
  return null;
});

/* --------------------------- caixa --------------------------- */

reportsRouter.get('/api/cash', async (ctx) => {
  requirePermission(ctx, 'cash:read');
  return cashSummary(ctx.url.searchParams.get('day') || businessDay());
});

reportsRouter.get('/api/cash/sessions', async (ctx) => {
  requirePermission(ctx, 'cash:read');
  return listCashSessions(ctx.url.searchParams.get('limit'));
});

reportsRouter.post('/api/cash/open', async (ctx) => {
  requirePermission(ctx, 'cash:open');
  const session = openCash({
    opening_float_cents: int(ctx.body.opening_float_cents, 'fundo de troco', { def: 0, min: 0 }),
    notes: str(ctx.body.notes, 'observações', { max: 500 }),
  }, ctx.user);
  audit(ctx.user.id, 'caixa_aberto', 'cash', session.id, null);
  return session;
});

reportsRouter.post('/api/cash/close', async (ctx) => {
  requirePermission(ctx, 'cash:close');
  const result = closeCash({
    counted_cents: int(ctx.body.counted_cents, 'valor contado', { def: 0, min: 0 }),
    notes: str(ctx.body.notes, 'observações', { max: 500 }),
  }, ctx.user);
  audit(ctx.user.id, 'caixa_fechado', 'cash', result.id, { difference: result.difference_cents });
  return result;
});

reportsRouter.get('/api/cash/current', async (ctx) => {
  requirePermission(ctx, 'cash:read');
  return currentCashSession();
});

/* --------------------------- impressão --------------------------- */

reportsRouter.get('/api/print/order/:id/kitchen', async (ctx) => {
  requirePermission(ctx, 'orders:read');
  return { text: kitchenTicket(Number(ctx.params.id)) };
});

reportsRouter.get('/api/print/order/:id/receipt', async (ctx) => {
  requirePermission(ctx, 'orders:read');
  return { text: customerReceipt(Number(ctx.params.id)) };
});

reportsRouter.get('/api/print/route/:id', async (ctx) => {
  requirePermission(ctx, 'routes:read');
  return { text: routeManifest(Number(ctx.params.id)) };
});

reportsRouter.get('/api/print/cash', async (ctx) => {
  requirePermission(ctx, 'cash:read');
  const day = ctx.url.searchParams.get('day') || businessDay();
  const summary = cashSummary(day);
  if (!summary) throw notFound('Nenhum movimento para o dia');
  return { text: cashTicket(summary) };
});

function cashTicket(summary) {
  const money = (c) => ((Number(c) || 0) / 100).toFixed(2).replace('.', ',');
  const out = [];
  out.push('FECHAMENTO DE CAIXA');
  out.push(`Dia comercial: ${summary.day}`);
  out.push('-'.repeat(40));
  out.push(`Pedidos: ${summary.totals.orders}`);
  out.push(`Vendas: R$ ${money(summary.totals.total_cents)}`);
  out.push(`Produtos: R$ ${money(summary.totals.subtotal_cents)}`);
  out.push(`Taxas de entrega: R$ ${money(summary.totals.fees_cents)}`);
  out.push(`Descontos: R$ ${money(summary.totals.discounts_cents)}`);
  out.push(`Em aberto: R$ ${money(summary.totals.open_cents)}`);
  out.push('-'.repeat(40));
  out.push('POR FORMA DE PAGAMENTO');
  for (const row of summary.by_method) out.push(`${row.method.padEnd(20)} R$ ${money(row.amount_cents)}`);
  out.push('-'.repeat(40));
  out.push(`Dinheiro esperado na gaveta: R$ ${money(summary.cash_expected_cents)}`);
  out.push(`Comissoes de entregadores: R$ ${money(summary.driver_commissions_cents)}`);
  out.push('-'.repeat(40));
  out.push('ENTREGADORES');
  for (const driver of summary.drivers) {
    out.push(`${driver.name}: ${driver.deliveries} entregas | comissao R$ ${money(driver.commission_cents)} | dinheiro R$ ${money(driver.cash_collected_cents)}`);
  }
  return out.join('\n');
}
