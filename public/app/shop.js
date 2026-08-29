/** Vitrine online: o cliente monta o pedido e ele cai direto na cozinha. */
import { api } from './api.js';
import { modal, toast } from './ui.js';
import { esc, money, plural } from './util.js';

const app = document.getElementById('app');
const hero = document.getElementById('hero');
const cart = [];
let store = null;
let menu = [];

async function boot() {
  try {
    [store, menu] = await Promise.all([api.get('/api/public/store'), api.get('/api/public/menu')]);
  } catch (err) {
    app.innerHTML = `<div class="card"><div class="body empty">Não consegui carregar o cardápio agora.<div class="small mt">${esc(err.message)}</div></div></div>`;
    return;
  }
  hero.innerHTML = `
    <h1>${esc(store.name)}</h1>
    <div class="row tight mt">
      ${store.service_hours ? `<span class="badge">🕒 ${esc(store.service_hours)}</span>` : ''}
      ${store.address ? `<span class="badge">📍 ${esc(store.address)}</span>` : ''}
      ${store.free_delivery_above_cents ? `<span class="badge">🛵 frete grátis acima de ${money(store.free_delivery_above_cents)}</span>` : ''}
      ${store.min_order_cents ? `<span class="badge">pedido mínimo ${money(store.min_order_cents)}</span>` : ''}
      <span class="badge">${store.online_orders ? '✅ aceitando pedidos' : '⛔ pedidos online fechados'}</span>
    </div>`;
  draw();
}

function draw() {
  app.innerHTML = `
  <div class="shop-grid">
    <div>
      ${menu.length ? menu.map((category) => `
        <h2 class="mt-lg mb">${esc(category.name)}</h2>
        ${category.products.map((product) => `
          <div class="dish" data-add="${product.id}">
            <div class="grow">
              <b>${esc(product.name)}</b>
              ${product.description ? `<div class="small muted">${esc(product.description)}</div>` : ''}
              ${product.options.length ? `<div class="small muted">${plural(product.options.length, 'adicional', 'adicionais')} ${product.options.length === 1 ? 'disponível' : 'disponíveis'}</div>` : ''}
            </div>
            <div class="price">${money(product.price_cents)}</div>
          </div>`).join('')}`).join('')
        : '<div class="card"><div class="body empty">Cardápio indisponível no momento.</div></div>'}
    </div>

    <div class="card cart-panel" id="cartPanel">
      <header><h3>Seu pedido</h3><span class="badge" id="count">0</span>
        <button class="btn-ghost btn-sm" id="toggle" style="margin-left:auto">▾</button></header>
      <div class="body cart-inner" id="cartBody"></div>
    </div>
  </div>`;

  app.querySelectorAll('[data-add]').forEach((el) => {
    el.onclick = () => addItem(Number(el.dataset.add));
  });
  app.querySelector('#toggle').onclick = () => app.querySelector('#cartPanel').classList.toggle('collapsed');
  drawCart();
}

const findProduct = (id) => menu.flatMap((c) => c.products).find((p) => p.id === id);
const itemUnit = (item) => item.unit_price_cents + item.options.reduce((acc, o) => acc + o.price_cents, 0);

async function addItem(productId) {
  const product = findProduct(productId);
  if (!product) return;
  let options = [];
  let notes = null;

  if (product.options.length) {
    const form = document.createElement('div');
    form.innerHTML = `<p class="muted small">${esc(product.name)} — ${money(product.price_cents)}</p>
      ${product.options.map((o) => `<label class="checkbox mb"><input type="checkbox" value="${o.id}" data-price="${o.price_cents}" data-name="${esc(o.name)}">
        ${esc(o.name)} ${o.price_cents ? `(+ ${money(o.price_cents)})` : ''}</label>`).join('')}
      <div class="field mt"><label>Observação</label><input id="notes" placeholder="Sem cebola"></div>`;
    const result = await modal({
      title: `Adicionar ${product.name}`,
      body: form,
      actions: [
        { label: 'Cancelar', className: 'btn-ghost', value: null },
        {
          label: 'Adicionar',
          onClick: ({ body }) => ({
            options: [...body.querySelectorAll('input:checked')].map((el) => ({ id: Number(el.value), name: el.dataset.name, price_cents: Number(el.dataset.price) })),
            notes: body.querySelector('#notes').value.trim() || null,
          }),
        },
      ],
    });
    if (!result) return;
    options = result.options;
    notes = result.notes;
  }

  const key = `${productId}|${options.map((o) => o.id).join(',')}|${notes || ''}`;
  const existing = cart.find((i) => i.key === key);
  if (existing) existing.qty += 1;
  else cart.push({ key, product_id: productId, name: product.name, unit_price_cents: product.price_cents, qty: 1, options, notes });
  toast(`${product.name} adicionado`, 'ok', 1600);
  drawCart();
}

function drawCart() {
  const subtotal = cart.reduce((acc, i) => acc + itemUnit(i) * i.qty, 0);
  const fee = store.free_delivery_above_cents && subtotal >= store.free_delivery_above_cents ? 0 : store.default_fee_cents;
  const belowMinimum = store.min_order_cents && subtotal < store.min_order_cents;
  app.querySelector('#count').textContent = cart.reduce((acc, i) => acc + i.qty, 0);
  app.querySelector('#cartBody').innerHTML = cart.length ? `
    ${cart.map((item, index) => `
      <div class="cart-item">
        <div class="grow"><b>${esc(item.name)}</b>
          ${item.options.map((o) => `<div class="small muted">+ ${esc(o.name)}</div>`).join('')}
          ${item.notes ? `<div class="small" style="color:var(--orange)">${esc(item.notes)}</div>` : ''}</div>
        <div class="qty"><button data-dec="${index}">−</button><span>${item.qty}</span><button data-inc="${index}">+</button></div>
        <div class="strong nowrap">${money(itemUnit(item) * item.qty)}</div>
      </div>`).join('')}
    <div class="totals">
      <div><span>Subtotal</span><span>${money(subtotal)}</span></div>
      <div><span>Entrega (estimada)</span><span>${money(fee)}</span></div>
      <div class="big"><span>Total</span><span>${money(subtotal + fee)}</span></div>
    </div>
    ${belowMinimum ? `<div class="badge orange mt">faltam ${money(store.min_order_cents - subtotal)} para o pedido mínimo</div>` : ''}
    <button class="btn-lg btn-block mt" id="checkout" ${store.online_orders && !belowMinimum ? '' : 'disabled'}>
      ${store.online_orders ? 'Finalizar pedido' : 'Pedidos online fechados'}</button>`
    : '<div class="empty">Seu carrinho está vazio<div class="small">Escolha os itens ao lado</div></div>';

  app.querySelectorAll('[data-inc]').forEach((b) => { b.onclick = () => { cart[b.dataset.inc].qty += 1; drawCart(); }; });
  app.querySelectorAll('[data-dec]').forEach((b) => {
    b.onclick = () => {
      const item = cart[b.dataset.dec];
      item.qty -= 1;
      if (item.qty <= 0) cart.splice(Number(b.dataset.dec), 1);
      drawCart();
    };
  });
  app.querySelector('#checkout')?.addEventListener('click', checkout);
}

async function checkout() {
  const form = document.createElement('div');
  form.innerHTML = `
    <div class="grid cols-2">
      <div class="field"><label>Seu nome</label><input id="name" required></div>
      <div class="field"><label>WhatsApp</label><input id="phone" placeholder="21 99999-0000"></div>
      <div class="field" style="grid-column:span 2"><label>Tipo</label>
        <select id="type"><option value="entrega">Entrega</option><option value="retirada">Retirar na loja</option></select></div>
      <div class="field" style="grid-column:span 2" data-delivery><label>Rua</label><input id="street"></div>
      <div class="field" data-delivery><label>Número</label><input id="number"></div>
      <div class="field" data-delivery><label>Complemento</label><input id="complement"></div>
      <div class="field" data-delivery><label>Bairro</label><input id="district"></div>
      <div class="field" data-delivery><label>Referência</label><input id="reference"></div>
      <div class="field"><label>Pagamento</label><select id="payment">
        <option value="dinheiro">Dinheiro</option><option value="pix">PIX</option>
        <option value="credito">Cartão de crédito</option><option value="debito">Cartão de débito</option></select></div>
      <div class="field"><label>Troco para (R$)</label><input id="change" placeholder="opcional"></div>
      <div class="field" style="grid-column:span 2"><label>Observações</label><textarea id="notes"></textarea></div>
    </div>`;
  form.querySelector('#type').onchange = (e) => {
    form.querySelectorAll('[data-delivery]').forEach((el) => { el.hidden = e.target.value !== 'entrega'; });
  };

  const result = await modal({
    title: 'Finalizar pedido',
    body: form,
    wide: true,
    actions: [
      { label: 'Voltar', className: 'btn-ghost', value: null },
      {
        label: 'Enviar pedido',
        onClick: async ({ body }) => {
          const type = body.querySelector('#type').value;
          const payload = {
            customer_name: body.querySelector('#name').value.trim(),
            customer_phone: body.querySelector('#phone').value.replace(/\D/g, '') || null,
            type,
            payment_method: body.querySelector('#payment').value,
            change_for_cents: Math.round(Number(String(body.querySelector('#change').value).replace(',', '.')) * 100) || 0,
            notes: body.querySelector('#notes').value.trim() || null,
            items: cart.map((i) => ({ product_id: i.product_id, qty: i.qty, notes: i.notes, options: i.options.map((o) => ({ id: o.id })) })),
          };
          if (!payload.customer_name) { toast('Informe seu nome', 'warn'); return false; }
          if (type === 'entrega') {
            Object.assign(payload, {
              street: body.querySelector('#street').value.trim(),
              number: body.querySelector('#number').value.trim(),
              complement: body.querySelector('#complement').value.trim(),
              district: body.querySelector('#district').value.trim(),
              reference: body.querySelector('#reference').value.trim(),
            });
            if (!payload.street) { toast('Informe o endereço de entrega', 'warn'); return false; }
          }
          return api.post('/api/public/orders', payload);
        },
      },
    ],
  });

  if (result?.code) {
    cart.length = 0;
    drawCart();
    await modal({
      title: 'Pedido enviado! 🎉',
      body: `<div class="center"><div style="font-size:40px">✅</div>
        <h2>Pedido ${esc(result.code)}</h2>
        <p>Total <b>${money(result.total_cents)}</b></p>
        <p class="small muted">Acompanhe o preparo pelo link abaixo.</p>
        <a class="btn btn-lg mt" href="${esc(result.track_url)}">Acompanhar meu pedido</a></div>`,
      actions: [{ label: 'Fechar', className: 'btn-ghost' }],
    });
    location.href = result.track_url;
  }
}

boot();
