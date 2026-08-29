/** Página pública de acompanhamento do pedido (link enviado ao cliente). */
import { api } from './api.js';
import { toast, notifyError } from './ui.js';
import { esc, formatPhone, money, time, dateTime } from './util.js';

const token = location.pathname.split('/').filter(Boolean).pop();
const app = document.getElementById('app');
const FLOW = [
  { status: 'recebido', label: 'Pedido recebido', icon: '🔔', hint: 'Recebemos seu pedido!' },
  { status: 'em_preparo', label: 'Em preparo', icon: '🔥', hint: 'A cozinha já está com ele.' },
  { status: 'pronto', label: 'Pronto', icon: '✅', hint: 'Seu pedido está pronto.' },
  { status: 'em_entrega', label: 'Saiu para entrega', icon: '🛵', hint: 'O entregador está a caminho.' },
  { status: 'entregue', label: 'Entregue', icon: '🎉', hint: 'Bom apetite!' },
];

async function load() {
  try {
    const order = await api.get(`/api/public/track/${encodeURIComponent(token)}`);
    draw(order);
  } catch (err) {
    app.innerHTML = `<div class="card"><div class="body empty">
      <span class="big">🔍</span><b>Pedido não encontrado</b>
      <div class="small mt">${esc(err.message)}</div></div></div>`;
  }
}

function draw(order) {
  const flow = order.type === 'entrega' ? FLOW : FLOW.filter((s) => s.status !== 'em_entrega');
  const currentIndex = flow.findIndex((s) => s.status === order.status);
  const cancelled = order.status === 'cancelado';
  const reached = new Set(order.timeline.map((e) => e.to));

  app.innerHTML = `
  <div class="center mb">
    <h1>${esc(order.store.name || 'Outfood')}</h1>
    <div class="muted small">Pedido <b class="mono">${esc(order.code)}</b> · ${dateTime(order.created_at)}</div>
  </div>

  <div class="card">
    <div class="body">
      ${cancelled ? `<div class="empty"><span class="big">✖</span><b>Pedido cancelado</b></div>` : `
        <div class="center mb">
          <div style="font-size:40px">${flow[Math.max(0, currentIndex)]?.icon || '📦'}</div>
          <h2>${esc(flow[Math.max(0, currentIndex)]?.label || order.status_label)}</h2>
          <div class="muted small">${esc(flow[Math.max(0, currentIndex)]?.hint || '')}</div>
          ${order.status !== 'entregue' && order.promised_at ? `<div class="badge orange mt">previsão ${time(order.promised_at)}</div>` : ''}
          ${order.driver_name && order.status === 'em_entrega' ? `<div class="badge blue mt">entregador: ${esc(order.driver_name)}</div>` : ''}
        </div>
        <div class="steps">
          ${flow.map((step, index) => {
            const done = reached.has(step.status) || index < currentIndex;
            const current = index === currentIndex;
            return `<div class="step ${done ? 'done' : ''} ${current ? 'current' : ''}">
              <div class="bullet">${done || current ? step.icon : index + 1}</div>
              <div><b>${esc(step.label)}</b><span class="small muted">${current ? esc(step.hint) : (done ? 'concluído' : 'aguardando')}</span></div>
            </div>`;
          }).join('')}
        </div>`}
    </div>
  </div>

  <div class="card">
    <header><h3>Seu pedido</h3></header>
    <div class="body">
      ${order.items.map((i) => `<div class="spread" style="padding:4px 0">
        <span>${i.qty}x ${esc(i.name)}
          ${(i.options || []).map((o) => `<div class="small muted">+ ${esc(o.name)}</div>`).join('')}</span>
        <span>${money(i.total_cents)}</span></div>`).join('')}
      <div class="totals">
        <div><span>Subtotal</span><span>${money(order.subtotal_cents)}</span></div>
        ${order.delivery_fee_cents ? `<div><span>Entrega</span><span>${money(order.delivery_fee_cents)}</span></div>` : ''}
        <div class="big"><span>Total</span><span>${money(order.total_cents)}</span></div>
      </div>
      ${order.address ? `<div class="small muted mt">📍 ${esc(order.address)}</div>` : '<div class="small muted mt">🏪 Retirada no balcão</div>'}
      ${order.store.phone ? `<div class="small mt">Dúvidas? <a href="tel:${esc(order.store.phone)}">${esc(formatPhone(order.store.phone))}</a></div>` : ''}
    </div>
  </div>

  ${order.status === 'entregue' ? `
    <div class="card"><div class="body center">
      ${order.rating ? `<b>Obrigado pela avaliação!</b><div class="stars mt">${[1, 2, 3, 4, 5].map((n) => `<span class="${n <= order.rating ? 'on' : ''}">⭐</span>`).join('')}</div>`
        : `<b>Como foi sua experiência?</b>
           <div class="stars mt" id="stars">${[1, 2, 3, 4, 5].map((n) => `<span data-star="${n}">⭐</span>`).join('')}</div>
           <textarea id="comment" class="mt" placeholder="Conte o que achou (opcional)"></textarea>
           <button class="btn-block mt" id="send" disabled>Enviar avaliação</button>`}
    </div></div>` : ''}

  <div class="center muted small mt">Atualiza sozinho a cada 20 segundos.</div>`;

  bindRating();
}

function bindRating() {
  const stars = document.getElementById('stars');
  if (!stars) return;
  let rating = 0;
  stars.querySelectorAll('[data-star]').forEach((star) => {
    star.onclick = () => {
      rating = Number(star.dataset.star);
      stars.querySelectorAll('[data-star]').forEach((s) => s.classList.toggle('on', Number(s.dataset.star) <= rating));
      document.getElementById('send').disabled = false;
    };
  });
  document.getElementById('send').onclick = async (event) => {
    event.target.disabled = true;
    try {
      await api.post(`/api/public/track/${encodeURIComponent(token)}/rating`, {
        rating, comment: document.getElementById('comment').value.trim() || null,
      });
      toast('Obrigado pela avaliação!', 'ok');
      load();
    } catch (err) { notifyError(err); event.target.disabled = false; }
  };
}

load();
setInterval(load, 20000);
