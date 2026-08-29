/** Caixa: abertura, conferência por forma de pagamento e fechamento com diferença. */
import { api } from '../api.js';
import { emptyState, modal, notifyError, printText, toast } from '../ui.js';
import { PAYMENT_LABELS, dateTime, dayLabel, esc, money, toCents, todayISO } from '../util.js';

export async function render(container) {
  await draw(container, todayISO());
}

async function draw(container, day) {
  const [summary, sessions] = await Promise.all([api.get(`/api/cash?day=${day}`), api.get('/api/cash/sessions')]);
  const session = summary.session;

  container.innerHTML = `
    <div class="row mb" style="justify-content:space-between">
      <div class="row tight"><label style="margin:0">Dia</label><input type="date" id="day" value="${esc(day)}" style="width:auto"></div>
      <div class="row tight">
        <button class="btn-ghost" id="print">🖨 Imprimir fechamento</button>
        ${session ? '<button class="btn-warn" id="close">Fechar caixa</button>' : '<button id="open">Abrir caixa</button>'}
      </div>
    </div>

    ${session ? `<div class="card"><div class="body spread">
      <div><b>Caixa aberto</b> desde ${dateTime(session.opened_at)}
        <div class="small muted">Fundo de troco: ${money(session.opening_float_cents)}</div></div>
      <div class="right"><div class="k muted small">Esperado na gaveta</div>
        <div class="v strong" style="font-size:22px">${money(summary.cash_expected_cents)}</div></div>
    </div></div>` : '<div class="card"><div class="body muted">Nenhum caixa aberto. Abra o caixa para conferir o dinheiro no fim do turno.</div></div>'}

    <div class="grid auto mb">
      ${stat('Vendas do dia', money(summary.totals.total_cents), `${summary.totals.orders} pedidos`, 'accent')}
      ${stat('Produtos', money(summary.totals.subtotal_cents), 'sem taxas', '')}
      ${stat('Taxas de entrega', money(summary.totals.fees_cents), 'recebido dos clientes', 'info')}
      ${stat('Em aberto', money(summary.totals.open_cents), 'pedidos não pagos', summary.totals.open_cents ? 'danger' : '')}
      ${stat('Comissões', money(summary.driver_commissions_cents), 'a pagar aos entregadores', 'warn')}
    </div>

    <div class="grid cols-2">
      <div class="card">
        <header><h3>Por forma de pagamento</h3></header>
        <div class="table-wrap">${summary.by_method.length ? `<table>
          <thead><tr><th>Forma</th><th class="num">Pedidos</th><th class="num">Valor</th></tr></thead>
          <tbody>${summary.by_method.map((m) => `<tr><td>${esc(PAYMENT_LABELS[m.method] || m.method)}</td>
            <td class="num">${m.orders}</td><td class="num strong">${money(m.amount_cents)}</td></tr>`).join('')}</tbody>
        </table>` : emptyState('💳', 'Sem movimento')}</div>
      </div>

      <div class="card">
        <header><h3>Acerto com entregadores</h3></header>
        <div class="table-wrap">${summary.drivers.length ? `<table>
          <thead><tr><th>Entregador</th><th class="num">Entregas</th><th class="num">Comissão</th><th class="num">Dinheiro</th></tr></thead>
          <tbody>${summary.drivers.map((d) => `<tr><td>${esc(d.name)}</td><td class="num">${d.deliveries}</td>
            <td class="num">${money(d.commission_cents)}</td><td class="num">${money(d.cash_collected_cents)}</td></tr>`).join('')}</tbody>
        </table>` : emptyState('🏍️', 'Sem entregas')}</div>
      </div>
    </div>

    <div class="card">
      <header><h3>Histórico de caixas</h3></header>
      <div class="table-wrap">${sessions.length ? `<table>
        <thead><tr><th>Dia</th><th>Abertura</th><th>Fechamento</th><th class="num">Esperado</th><th class="num">Contado</th><th class="num">Diferença</th></tr></thead>
        <tbody>${sessions.map((s) => `<tr>
          <td>${dayLabel(s.business_day)} ${s.status === 'aberto' ? '<span class="badge green">aberto</span>' : ''}</td>
          <td class="small">${dateTime(s.opened_at)}<div class="muted">${esc(s.opened_by_name || '')}</div></td>
          <td class="small">${s.closed_at ? dateTime(s.closed_at) : '—'}<div class="muted">${esc(s.closed_by_name || '')}</div></td>
          <td class="num">${money(s.expected_cents)}</td><td class="num">${money(s.counted_cents)}</td>
          <td class="num ${s.difference_cents < 0 ? 'strong' : ''}" style="${s.difference_cents < 0 ? 'color:var(--red)' : ''}">${money(s.difference_cents)}</td>
        </tr>`).join('')}</tbody></table>` : emptyState('📒', 'Nenhum caixa registrado')}</div>
    </div>`;

  container.querySelector('#day').onchange = (e) => draw(container, e.target.value);
  container.querySelector('#print').onclick = async () => {
    try { const { text } = await api.print(`/api/print/cash?day=${day}`); printText(text); } catch (err) { notifyError(err); }
  };
  container.querySelector('#open')?.addEventListener('click', () => openDialog(container, day));
  container.querySelector('#close')?.addEventListener('click', () => closeDialog(container, day, summary));
}

function stat(label, value, sub, kind) {
  return `<div class="stat ${kind}"><div class="k">${esc(label)}</div><div class="v">${esc(value)}</div><div class="s">${esc(sub)}</div></div>`;
}

async function openDialog(container, day) {
  const form = document.createElement('div');
  form.innerHTML = `
    <div class="field"><label>Fundo de troco (R$)</label><input id="float" placeholder="100,00"></div>
    <div class="field"><label>Observações</label><textarea id="notes" placeholder="Turno da noite"></textarea></div>`;
  const done = await modal({
    title: 'Abrir caixa',
    body: form,
    actions: [
      { label: 'Cancelar', className: 'btn-ghost', value: false },
      {
        label: 'Abrir',
        onClick: async ({ body }) => {
          await api.post('/api/cash/open', {
            opening_float_cents: toCents(body.querySelector('#float').value),
            notes: body.querySelector('#notes').value.trim() || null,
          });
          return true;
        },
      },
    ],
  });
  if (done) { toast('Caixa aberto', 'ok'); draw(container, day); }
}

async function closeDialog(container, day, summary) {
  const form = document.createElement('div');
  form.innerHTML = `
    <p>Esperado na gaveta: <b>${money(summary.cash_expected_cents)}</b>
      <span class="muted small">(fundo de troco + vendas em dinheiro)</span></p>
    <div class="field"><label>Valor contado (R$)</label><input id="counted" placeholder="0,00" autofocus></div>
    <div class="field"><label>Observações</label><textarea id="notes"></textarea></div>
    <div id="diff" class="hint"></div>`;
  form.querySelector('#counted').oninput = (e) => {
    const diff = toCents(e.target.value) - summary.cash_expected_cents;
    form.querySelector('#diff').innerHTML = diff === 0
      ? '<span class="badge green">caixa bate certinho</span>'
      : `<span class="badge ${diff > 0 ? 'blue' : 'red'}">${diff > 0 ? 'sobra' : 'falta'} de ${money(Math.abs(diff))}</span>`;
  };
  const done = await modal({
    title: 'Fechar caixa',
    body: form,
    actions: [
      { label: 'Cancelar', className: 'btn-ghost', value: false },
      {
        label: 'Fechar caixa',
        className: 'btn-warn',
        onClick: async ({ body }) => {
          await api.post('/api/cash/close', {
            counted_cents: toCents(body.querySelector('#counted').value),
            notes: body.querySelector('#notes').value.trim() || null,
          });
          return true;
        },
      },
    ],
  });
  if (done) { toast('Caixa fechado', 'ok'); draw(container, day); }
}
