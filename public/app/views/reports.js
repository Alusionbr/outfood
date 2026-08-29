/** Relatórios: série de vendas, ranking de produtos e clientes, exportação CSV. */
import { api } from '../api.js';
import { emptyState, notifyError } from '../ui.js';
import { dayLabel, esc, money, todayISO } from '../util.js';

export async function render(container) {
  const to = todayISO();
  const from = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  container.innerHTML = `
    <div class="card"><div class="body row">
      <div><label>De</label><input type="date" id="from" value="${from}"></div>
      <div><label>Até</label><input type="date" id="to" value="${to}"></div>
      <div style="align-self:flex-end"><button id="apply">Aplicar</button></div>
      <div style="align-self:flex-end;margin-left:auto">
        <a class="btn btn-2" id="csv" href="/api/reports/orders.csv?from=${from}&to=${to}">⬇ Exportar CSV</a>
      </div>
    </div></div>
    <div id="report"><div class="loading">Carregando relatórios...</div></div>`;

  const load = async () => {
    const f = container.querySelector('#from').value;
    const t = container.querySelector('#to').value;
    container.querySelector('#csv').href = `/api/reports/orders.csv?from=${f}&to=${t}`;
    try {
      const [sales, products, customers] = await Promise.all([
        api.get(`/api/reports/sales?from=${f}&to=${t}`),
        api.get(`/api/reports/products?from=${f}&to=${t}`),
        api.get(`/api/reports/customers?from=${f}&to=${t}`),
      ]);
      container.querySelector('#report').innerHTML = body(sales, products, customers);
    } catch (err) { notifyError(err); }
  };
  container.querySelector('#apply').onclick = load;
  await load();
}

function body(sales, products, customers) {
  const days = sales.days;
  const revenue = days.reduce((acc, d) => acc + d.revenue_cents, 0);
  const orders = days.reduce((acc, d) => acc + d.orders, 0);
  const max = Math.max(1, ...days.map((d) => d.revenue_cents));
  return `
  <div class="grid auto mb">
    <div class="stat accent"><div class="k">Faturamento no período</div><div class="v">${money(revenue)}</div><div class="s">${orders} pedidos</div></div>
    <div class="stat info"><div class="k">Ticket médio</div><div class="v">${money(orders ? Math.round(revenue / orders) : 0)}</div><div class="s">por pedido</div></div>
    <div class="stat"><div class="k">Média diária</div><div class="v">${money(days.length ? Math.round(revenue / days.length) : 0)}</div><div class="s">${days.length} dias com venda</div></div>
    <div class="stat warn"><div class="k">Taxas de entrega</div><div class="v">${money(days.reduce((a, d) => a + d.fees_cents, 0))}</div><div class="s">no período</div></div>
  </div>

  <div class="card">
    <header><h3>Faturamento por dia</h3></header>
    <div class="body">
      ${days.length ? `<div class="chart-bars">${days.map((d) => `
        <div class="bar" style="height:${Math.round((d.revenue_cents / max) * 100)}%"
          title="${dayLabel(d.day)} — ${d.orders} pedidos · ${money(d.revenue_cents)}"></div>`).join('')}</div>
        <div class="chart-labels">${days.map((d, i) => `<span>${days.length > 15 && i % 3 ? '' : d.day.slice(8)}</span>`).join('')}</div>`
        : emptyState('📉', 'Sem vendas no período')}
    </div>
  </div>

  <div class="grid cols-2">
    <div class="card">
      <header><h3>Produtos mais rentáveis</h3></header>
      <div class="table-wrap scroll-y">${products.length ? `<table>
        <thead><tr><th>Produto</th><th class="num">Qtd</th><th class="num">Faturamento</th></tr></thead>
        <tbody>${products.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${Math.round(p.qty)}</td>
          <td class="num strong">${money(p.revenue_cents)}</td></tr>`).join('')}</tbody></table>` : emptyState('🍽️', 'Sem dados')}
      </div>
    </div>
    <div class="card">
      <header><h3>Melhores clientes</h3></header>
      <div class="table-wrap scroll-y">${customers.length ? `<table>
        <thead><tr><th>Cliente</th><th class="num">Pedidos</th><th class="num">Total</th></tr></thead>
        <tbody>${customers.map((c) => `<tr><td>${esc(c.name)}<div class="small muted">${esc(c.phone)}</div></td>
          <td class="num">${c.orders}</td><td class="num strong">${money(c.revenue_cents)}</td></tr>`).join('')}</tbody></table>`
        : emptyState('👥', 'Sem clientes no período')}
      </div>
    </div>
  </div>`;
}
