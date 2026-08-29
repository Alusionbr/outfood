/**
 * PDV — registro de pedido em uma tela só: busca do cliente pelo telefone,
 * cardápio clicável, carrinho com adicionais e fechamento com taxa calculada.
 */
import { api } from '../api.js';
import { state } from '../store.js';
import { modal, notifyError, printWithQr, toast } from '../ui.js';
import { orderQrPayload, qrBlock } from '../navigation.js';
import { CHANNEL_LABELS, PAYMENT_LABELS, esc, money, toCents } from '../util.js';

const cart = [];
let customer = null;
let addresses = [];
let menu = [];

export async function render(container) {
  menu = state.menu.length ? state.menu : await api.menu();
  cart.length = 0;
  customer = null;
  addresses = [];
  container.innerHTML = template();
  bind(container);
  renderCart(container);
}

function template() {
  const categories = menu.filter((c) => c.products.length);
  return `
  <div class="pdv">
    <div>
      <div class="card">
        <header>
          <h3>Cardápio</h3>
          <input type="search" id="search" placeholder="Buscar produto..." style="width:230px;margin-left:auto">
        </header>
        <div class="body">
          <div class="tabs" id="cats">
            <button class="active" data-cat="">Todos</button>
            ${categories.map((c) => `<button data-cat="${c.id ?? ''}">${esc(c.name)}</button>`).join('')}
          </div>
          <div class="product-grid" id="products"></div>
        </div>
      </div>
    </div>

    <div>
      <div class="card">
        <header><h3>Cliente</h3></header>
        <div class="body">
          <div class="field"><label>Telefone (busca automática)</label>
            <div class="row tight"><input type="tel" id="phone" placeholder="21 99999-0000" class="grow">
              <button class="btn-2 btn-sm" id="lookup">Buscar</button></div>
            <div class="hint" id="customerInfo">Digite o telefone para recuperar o cadastro.</div>
          </div>
          <div class="field"><label>Nome</label><input type="text" id="name" placeholder="Nome do cliente"></div>
          <div class="grid cols-2">
            <div class="field"><label>Tipo</label>
              <select id="type"><option value="entrega">Entrega</option><option value="retirada">Retirada</option><option value="salao">Salão</option></select></div>
            <div class="field"><label>Canal</label>
              <select id="channel">${Object.entries(CHANNEL_LABELS).map(([k, v]) => `<option value="${k}" ${k === 'telefone' ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
          </div>
          <div id="addressBlock">
            <div class="field" id="savedAddresses" hidden><label>Endereço salvo</label><select id="addressId"></select></div>
            <div class="grid cols-2">
              <div class="field" style="grid-column:span 2"><label>Rua</label><input type="text" id="street" placeholder="Rua, avenida..."></div>
              <div class="field"><label>Número</label><input type="text" id="number" placeholder="100"></div>
              <div class="field"><label>Complemento</label><input type="text" id="complement" placeholder="Apto 201"></div>
              <div class="field"><label>Bairro</label><input type="text" id="district" list="districts" placeholder="Bairro">
                <datalist id="districts">${[...new Set(state.zones.map((z) => z.name))].map((n) => `<option value="${esc(n)}">`).join('')}</datalist></div>
              <div class="field"><label>Referência</label><input type="text" id="reference" placeholder="Perto da praça"></div>
            </div>
            <label class="checkbox"><input type="checkbox" id="saveAddress" checked> Salvar endereço no cadastro</label>
          </div>
        </div>
      </div>

      <div class="card">
        <header><h3>Carrinho</h3><span class="badge" id="cartCount">0</span></header>
        <div class="body">
          <div id="cartItems"></div>
          <div class="grid cols-2 mt">
            <div class="field"><label>Desconto (R$)</label><input type="number" step="0.01" id="discount" value="0"></div>
            <div class="field"><label>Taxa de entrega (R$)</label><input type="text" id="fee" placeholder="automática"></div>
          </div>
          <div class="field"><label>Forma de pagamento</label>
            <select id="payment"><option value="">A definir</option>
              ${Object.entries(PAYMENT_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
          <div class="field" id="changeField" hidden><label>Troco para (R$)</label><input type="number" step="0.01" id="changeFor" placeholder="50,00"></div>
          <label class="checkbox mb"><input type="checkbox" id="paid"> Já está pago</label>
          <div class="field"><label>Observações da cozinha</label><textarea id="notes" placeholder="Sem cebola, ponto da carne..."></textarea></div>
          <div class="totals" id="totals"></div>
          <button class="btn-lg btn-block mt" id="submit">Lançar pedido</button>
          <button class="btn-ghost btn-block mt" id="clear">Limpar</button>
        </div>
      </div>
    </div>
  </div>`;
}

function bind(container) {
  const q = (sel) => container.querySelector(sel);
  drawProducts(container, '', '');

  q('#cats').onclick = (event) => {
    const button = event.target.closest('button[data-cat]');
    if (!button) return;
    container.querySelectorAll('#cats button').forEach((b) => b.classList.toggle('active', b === button));
    drawProducts(container, button.dataset.cat, q('#search').value);
  };
  q('#search').oninput = () => {
    const active = container.querySelector('#cats button.active');
    drawProducts(container, active?.dataset.cat || '', q('#search').value);
  };
  q('#lookup').onclick = () => lookupCustomer(container);
  q('#phone').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); lookupCustomer(container); } };
  q('#phone').onblur = () => { if (q('#phone').value.replace(/\D/g, '').length >= 10) lookupCustomer(container); };
  q('#type').onchange = () => {
    q('#addressBlock').hidden = q('#type').value !== 'entrega';
    renderCart(container);
  };
  q('#payment').onchange = () => { q('#changeField').hidden = q('#payment').value !== 'dinheiro'; };
  q('#discount').oninput = () => renderCart(container);
  q('#fee').oninput = () => renderCart(container);
  q('#clear').onclick = () => render(container);
  q('#submit').onclick = () => submit(container);
  q('#addressId').onchange = () => fillAddress(container, q('#addressId').value);
}

function drawProducts(container, categoryId, search) {
  const term = (search || '').toLowerCase();
  const products = menu
    .filter((c) => !categoryId || String(c.id ?? '') === String(categoryId))
    .flatMap((c) => c.products)
    .filter((p) => p.active && (!term || p.name.toLowerCase().includes(term) || (p.description || '').toLowerCase().includes(term)));

  container.querySelector('#products').innerHTML = products.length ? products.map((p) => `
    <button class="product ${p.available ? '' : 'off'}" data-id="${p.id}" ${p.available ? '' : 'disabled'}>
      <span class="name">${esc(p.name)}</span>
      ${p.description ? `<span class="desc">${esc(p.description)}</span>` : ''}
      <span class="price">${money(p.price_cents)}</span>
      ${p.stock_control ? `<span class="small muted">estoque: ${p.stock_qty}</span>` : ''}
    </button>`).join('') : '<div class="empty">Nenhum produto encontrado</div>';

  container.querySelectorAll('.product[data-id]').forEach((button) => {
    button.onclick = () => addToCart(container, Number(button.dataset.id));
  });
}

function findProduct(id) {
  return menu.flatMap((c) => c.products).find((p) => p.id === id);
}

async function addToCart(container, productId) {
  const product = findProduct(productId);
  if (!product) return;

  let options = [];
  let notes = null;
  if (product.options?.length) {
    const form = document.createElement('div');
    form.innerHTML = `
      <p class="muted small">${esc(product.name)} — ${money(product.price_cents)}</p>
      ${product.options.map((o) => `<label class="checkbox mb">
        <input type="checkbox" value="${o.id}" data-price="${o.price_cents}" data-name="${esc(o.name)}">
        ${esc(o.group_name)}: ${esc(o.name)} ${o.price_cents ? `(+ ${money(o.price_cents)})` : ''}</label>`).join('')}
      <div class="field mt"><label>Observação do item</label><input type="text" id="itemNotes" placeholder="Sem cebola"></div>`;
    const result = await modal({
      title: `Adicionar ${product.name}`,
      body: form,
      actions: [
        { label: 'Cancelar', className: 'btn-ghost', value: null },
        {
          label: 'Adicionar',
          onClick: ({ body }) => ({
            options: [...body.querySelectorAll('input[type=checkbox]:checked')].map((el) => ({
              id: Number(el.value), name: el.dataset.name, price_cents: Number(el.dataset.price),
            })),
            notes: body.querySelector('#itemNotes').value.trim() || null,
          }),
        },
      ],
    });
    if (!result) return;
    options = result.options;
    notes = result.notes;
  }

  const key = `${productId}|${options.map((o) => o.id).sort().join(',')}|${notes || ''}`;
  const existing = cart.find((item) => item.key === key);
  if (existing) existing.qty += 1;
  else cart.push({ key, product_id: productId, name: product.name, unit_price_cents: product.price_cents, qty: 1, options, notes });
  renderCart(container);
}

function renderCart(container) {
  const list = container.querySelector('#cartItems');
  container.querySelector('#cartCount').textContent = cart.reduce((acc, i) => acc + i.qty, 0);
  if (!cart.length) {
    list.innerHTML = '<div class="empty">Carrinho vazio<div class="small">Clique nos produtos ao lado</div></div>';
  } else {
    list.innerHTML = cart.map((item, index) => `
      <div class="cart-item">
        <div class="grow">
          <div class="strong">${esc(item.name)}</div>
          ${item.options.map((o) => `<div class="small muted">+ ${esc(o.name)}</div>`).join('')}
          ${item.notes ? `<div class="small" style="color:var(--orange)">${esc(item.notes)}</div>` : ''}
          <div class="small muted">${money(itemUnit(item))} un.</div>
        </div>
        <div class="qty">
          <button data-dec="${index}">−</button><span>${item.qty}</span><button data-inc="${index}">+</button>
        </div>
        <div class="strong nowrap">${money(itemUnit(item) * item.qty)}</div>
        <button class="icon-btn" data-del="${index}" title="Remover">✕</button>
      </div>`).join('');
    list.querySelectorAll('[data-inc]').forEach((b) => { b.onclick = () => { cart[b.dataset.inc].qty += 1; renderCart(container); }; });
    list.querySelectorAll('[data-dec]').forEach((b) => {
      b.onclick = () => {
        const item = cart[b.dataset.dec];
        item.qty -= 1;
        if (item.qty <= 0) cart.splice(Number(b.dataset.dec), 1);
        renderCart(container);
      };
    });
    list.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => { cart.splice(Number(b.dataset.del), 1); renderCart(container); }; });
  }
  renderTotals(container);
}

const itemUnit = (item) => item.unit_price_cents + item.options.reduce((acc, o) => acc + (o.price_cents || 0), 0);

function renderTotals(container) {
  const subtotal = cart.reduce((acc, item) => acc + itemUnit(item) * item.qty, 0);
  const discount = toCents(container.querySelector('#discount').value);
  const feeInput = container.querySelector('#fee').value.trim();
  const isDelivery = container.querySelector('#type').value === 'entrega';
  const fee = feeInput ? toCents(feeInput) : estimatedFee(subtotal, isDelivery);
  const total = Math.max(0, subtotal + fee - discount);
  container.querySelector('#totals').innerHTML = `
    <div><span>Subtotal</span><span>${money(subtotal)}</span></div>
    <div><span>Taxa de entrega ${feeInput ? '' : '<span class="muted small">(estimada)</span>'}</span><span>${money(fee)}</span></div>
    ${discount ? `<div><span>Desconto</span><span>- ${money(discount)}</span></div>` : ''}
    <div class="big"><span>Total</span><span>${money(total)}</span></div>`;
}

/** Estimativa local só para exibição — o servidor recalcula na hora de salvar. */
function estimatedFee(subtotal, isDelivery) {
  if (!isDelivery) return 0;
  const s = state.settings;
  if (s.free_delivery_above_cents && subtotal >= s.free_delivery_above_cents) return 0;
  return Number(s.default_fee_cents) || 0;
}

async function lookupCustomer(container) {
  const phone = container.querySelector('#phone').value.replace(/\D/g, '');
  if (phone.length < 10) return;
  try {
    const result = await api.get(`/api/customers/lookup?phone=${phone}`);
    const info = container.querySelector('#customerInfo');
    if (!result.found) {
      customer = null;
      addresses = [];
      container.querySelector('#savedAddresses').hidden = true;
      info.innerHTML = '<span class="badge orange">cliente novo</span> será cadastrado ao lançar o pedido';
      return;
    }
    customer = result.customer;
    addresses = customer.addresses || [];
    container.querySelector('#name').value = customer.name;
    info.innerHTML = `<span class="badge green">cliente conhecido</span> ${customer.orders_count} pedidos · ${money(customer.spent_cents)} no total`;
    const select = container.querySelector('#addressId');
    container.querySelector('#savedAddresses').hidden = addresses.length === 0;
    select.innerHTML = '<option value="">Novo endereço</option>' + addresses.map((a) => `
      <option value="${a.id}" ${a.is_default ? 'selected' : ''}>${esc([a.street, a.number, a.district].filter(Boolean).join(', '))}</option>`).join('');
    if (addresses.length) fillAddress(container, String(addresses.find((a) => a.is_default)?.id ?? addresses[0].id));
  } catch (err) { notifyError(err); }
}

function fillAddress(container, addressId) {
  const address = addresses.find((a) => String(a.id) === String(addressId));
  const fields = ['street', 'number', 'complement', 'district', 'reference'];
  for (const field of fields) container.querySelector(`#${field}`).value = address ? (address[field] || '') : '';
  container.querySelector('#saveAddress').checked = !address;
}

async function submit(container) {
  const q = (sel) => container.querySelector(sel);
  if (!cart.length) return toast('Adicione ao menos um item', 'warn');
  const type = q('#type').value;
  const name = q('#name').value.trim();
  if (!name) { q('#name').focus(); return toast('Informe o nome do cliente', 'warn'); }
  if (type === 'entrega' && !q('#street').value.trim()) { q('#street').focus(); return toast('Informe o endereço de entrega', 'warn'); }

  const addressId = q('#addressId').value;
  const payload = {
    customer_id: customer?.id ?? null,
    customer_name: name,
    customer_phone: q('#phone').value.replace(/\D/g, '') || null,
    type,
    channel: q('#channel').value,
    notes: q('#notes').value.trim() || null,
    discount_cents: toCents(q('#discount').value),
    payment_method: q('#payment').value || null,
    change_for_cents: toCents(q('#changeFor')?.value),
    paid: q('#paid').checked,
    save_address: q('#saveAddress').checked,
    items: cart.map((item) => ({
      product_id: item.product_id, qty: item.qty, notes: item.notes, options: item.options,
    })),
  };
  if (q('#fee').value.trim()) payload.delivery_fee_cents = toCents(q('#fee').value);
  if (type === 'entrega') {
    if (addressId && !q('#saveAddress').checked) payload.address_id = Number(addressId);
    Object.assign(payload, {
      street: q('#street').value.trim(),
      number: q('#number').value.trim(),
      complement: q('#complement').value.trim(),
      district: q('#district').value.trim(),
      reference: q('#reference').value.trim(),
    });
  }

  const button = q('#submit');
  button.disabled = true;
  button.textContent = 'Lançando...';
  try {
    const order = await api.createOrder(payload);
    toast(`Pedido ${order.code} lançado — ${money(order.total_cents)}`, 'ok');
    await afterCreate(order);
    render(container);
  } catch (err) {
    notifyError(err);
  } finally {
    button.disabled = false;
    button.textContent = 'Lançar pedido';
  }
}

async function afterCreate(order) {
  const choice = await modal({
    title: `Pedido ${order.code} criado`,
    body: `<p>Total <b>${money(order.total_cents)}</b>${order.delivery_fee_cents ? ` (taxa ${money(order.delivery_fee_cents)})` : ''}.</p>
      <p class="small muted">Link de acompanhamento do cliente:<br><code>${location.origin}/r/${esc(order.public_token)}</code></p>`,
    actions: [
      { label: 'Fechar', className: 'btn-ghost', value: 'close' },
      { label: '🧾 Cupom', className: 'btn-2', value: 'receipt' },
      { label: '🖨 Comanda da cozinha', value: 'kitchen' },
    ],
  });
  if (choice === 'kitchen' || choice === 'receipt') {
    try {
      const { text } = await api.print(`/api/print/order/${order.id}/${choice}`);
      const qr = choice === 'kitchen'
        ? qrBlock(orderQrPayload(order.code), `Pedido ${order.code}`, 140)
        : qrBlock(`${location.origin}/r/${order.public_token}`, 'Acompanhe seu pedido', 140);
      printWithQr(text, qr);
    } catch (err) { notifyError(err); }
  }
}
