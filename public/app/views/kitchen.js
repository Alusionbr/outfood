/** KDS — tela de produção. Feita para ficar aberta num monitor da cozinha. */
import { api } from '../api.js';
import { onServerEvent } from '../store.js';
import { emptyState, notifyError, printWithQr } from '../ui.js';
import { orderQrPayload, qrBlock } from '../navigation.js';
import { esc, minutesUntil, money, since, time } from '../util.js';

let unsubscribe = null;
let tick = null;

export async function render(container) {
  unsubscribe?.();
  clearInterval(tick);
  container.innerHTML = `
    <div class="row mb" style="justify-content:space-between">
      <div class="row tight">
        <span class="badge blue">🔔 novos</span><span class="badge orange">🔥 em preparo</span><span class="badge green">✅ prontos</span>
      </div>
      <div class="row tight">
        <span class="muted small" id="clock"></span>
        <button class="btn-ghost btn-sm" id="reload">Atualizar</button>
      </div>
    </div>
    <div class="board" id="board"><div class="loading">Carregando comandas...</div></div>`;
  container.querySelector('#reload').onclick = () => load(container);
  await load(container);
  unsubscribe = onServerEvent('*', (data, name) => { if (name.startsWith('order:')) load(container, true); });
  tick = setInterval(() => {
    const clock = container.querySelector('#clock');
    if (clock) clock.textContent = new Date().toLocaleTimeString('pt-BR');
    load(container, true);
  }, 30000);
}

export function destroy() { unsubscribe?.(); clearInterval(tick); }

async function load(container, silent = false) {
  try {
    const orders = await api.kitchen();
    const board = container.querySelector('#board');
    if (!board) return;
    board.innerHTML = [
      column('🔔 Novos', 'recebido', orders.filter((o) => o.status === 'recebido'), 'em_preparo', 'Iniciar preparo'),
      column('🔥 Em preparo', 'em_preparo', orders.filter((o) => o.status === 'em_preparo'), 'pronto', 'Marcar pronto'),
      column('✅ Prontos', 'pronto', orders.filter((o) => o.status === 'pronto'), null, null),
    ].join('');
    board.querySelectorAll('[data-advance]').forEach((button) => {
      button.onclick = async (event) => {
        event.stopPropagation();
        try {
          await api.setStatus(Number(button.dataset.id), button.dataset.advance);
          load(container, true);
        } catch (err) { notifyError(err); }
      };
    });
    board.querySelectorAll('[data-print]').forEach((button) => {
      button.onclick = async (event) => {
        event.stopPropagation();
        const order = orders.find((o) => String(o.id) === button.dataset.print);
        try {
          const { text } = await api.print(`/api/print/order/${button.dataset.print}/kitchen`);
          // O QR na comanda deixa o entregador puxar o pedido para a rota dele.
          printWithQr(text, qrBlock(orderQrPayload(order.code), `Pedido ${order.code}`, 140));
        } catch (err) { notifyError(err); }
      };
    });
  } catch (err) {
    if (!silent) notifyError(err);
  }
}

function column(title, status, orders, nextStatus, nextLabel) {
  return `
  <section class="column">
    <header>${title}<span class="badge ${orders.length ? 'dark' : 'gray'}">${orders.length}</span></header>
    <div class="items">
      ${orders.length ? orders.map((o) => ticket(o, nextStatus, nextLabel)).join('') : emptyState('🍳', 'Nada aqui')}
    </div>
  </section>`;
}

function ticket(order, nextStatus, nextLabel) {
  const remaining = minutesUntil(order.promised_at);
  const urgency = order.late || (remaining != null && remaining < 0) ? 'late' : (remaining != null && remaining < 8 ? 'warn' : '');
  return `
  <article class="ticket ${urgency}">
    <div class="head">
      <span class="code">${esc(order.code)}</span>
      <span class="badge ${order.type === 'entrega' ? 'blue' : 'gray'}">${order.type === 'entrega' ? '🛵' : '🏪'}</span>
      <span class="when">${since(order.created_at)}</span>
    </div>
    <div class="who">${esc(order.customer_name)}</div>
    <div class="where small muted">
      ${order.type === 'entrega' ? esc(order.district || 'sem bairro') : 'retirada no balcão'}
      · promessa ${time(order.promised_at)}
      ${remaining != null ? (remaining < 0 ? `<b style="color:var(--red)"> ${Math.abs(remaining)} min atrasado</b>` : ` (${remaining} min)`) : ''}
    </div>
    <ul>${order.items.map((i) => `<li><b>${i.qty}x</b> ${esc(i.name)}
      ${(i.options || []).map((o) => `<div class="small">+ ${esc(o.name)}</div>`).join('')}
      ${i.notes ? `<div class="small" style="color:var(--orange)">⚠ ${esc(i.notes)}</div>` : ''}</li>`).join('')}</ul>
    ${order.notes ? `<div class="small mt" style="color:var(--orange)">⚠ ${esc(order.notes)}</div>` : ''}
    <div class="foot">
      ${nextStatus ? `<button class="btn-sm" data-id="${order.id}" data-advance="${nextStatus}">${esc(nextLabel)}</button>` : `<span class="badge green">aguardando saída · ${money(order.total_cents)}</span>`}
      <button class="btn-ghost btn-sm" data-print="${order.id}">🖨</button>
    </div>
  </article>`;
}
