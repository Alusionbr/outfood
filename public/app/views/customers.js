/** Clientes: cadastro, endereços salvos e histórico de pedidos. */
import { api } from '../api.js';
import { confirmDialog, emptyState, modal, notifyError, toast } from '../ui.js';
import { dateTime, esc, money, statusBadge } from '../util.js';

let term = '';

export async function render(container) {
  container.innerHTML = `
    <div class="card">
      <header>
        <h3>Clientes</h3>
        <input type="search" id="q" placeholder="Nome ou telefone..." style="width:260px;margin-left:auto" value="${esc(term)}">
        <button id="new">+ Novo cliente</button>
      </header>
      <div class="table-wrap" id="list"><div class="loading">Carregando...</div></div>
    </div>`;
  let timer;
  container.querySelector('#q').oninput = (e) => {
    term = e.target.value.trim();
    clearTimeout(timer);
    timer = setTimeout(() => load(container), 320);
  };
  container.querySelector('#new').onclick = () => editDialog(container, null);
  await load(container);
}

async function load(container) {
  try {
    const customers = await api.customers(term ? `q=${encodeURIComponent(term)}` : '');
    const list = container.querySelector('#list');
    list.innerHTML = customers.length ? `<table>
      <thead><tr><th>Cliente</th><th>Telefone</th><th class="num">Pedidos</th><th class="num">Total gasto</th><th>Último pedido</th><th></th></tr></thead>
      <tbody>${customers.map((c) => `
        <tr>
          <td><b>${esc(c.name)}</b>${c.blocked ? ' <span class="badge red">bloqueado</span>' : ''}
            ${c.notes ? `<div class="small muted">${esc(c.notes)}</div>` : ''}</td>
          <td>${esc(c.phone_formatted)}</td>
          <td class="num">${c.orders_count}</td>
          <td class="num strong">${money(c.spent_cents)}</td>
          <td class="small muted">${c.last_order_at ? dateTime(c.last_order_at) : '—'}</td>
          <td class="right nowrap">
            <button class="btn-ghost btn-sm" data-view="${c.id}">Ficha</button>
            <button class="btn-ghost btn-sm" data-edit="${c.id}">Editar</button>
          </td>
        </tr>`).join('')}</tbody></table>`
      : emptyState('👥', 'Nenhum cliente encontrado', 'Clientes são criados automaticamente ao lançar pedidos com telefone.');

    list.querySelectorAll('[data-view]').forEach((b) => { b.onclick = () => detail(container, Number(b.dataset.view)); });
    list.querySelectorAll('[data-edit]').forEach((b) => {
      b.onclick = async () => {
        const customer = await api.get(`/api/customers/${b.dataset.edit}`);
        editDialog(container, customer);
      };
    });
  } catch (err) { notifyError(err); }
}

async function detail(container, id) {
  let customer;
  try { customer = await api.get(`/api/customers/${id}`); } catch (err) { return notifyError(err); }
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="grid auto mb">
      <div class="stat"><div class="k">Pedidos</div><div class="v">${customer.orders_count}</div></div>
      <div class="stat accent"><div class="k">Total gasto</div><div class="v">${money(customer.spent_cents)}</div></div>
      <div class="stat info"><div class="k">Ticket médio</div><div class="v">${money(customer.orders_count ? Math.round(customer.spent_cents / customer.orders_count) : 0)}</div></div>
    </div>
    <div class="spread"><h4>Endereços</h4><button class="btn-2 btn-sm" id="addAddress">+ Endereço</button></div>
    <div class="stack mt mb">${customer.addresses.length ? customer.addresses.map((a) => `
      <div class="row" style="border:1px solid var(--border);border-radius:9px;padding:9px">
        <div class="grow">
          <b>${esc(a.label || 'Endereço')}</b> ${a.is_default ? '<span class="badge green">padrão</span>' : ''}
          ${a.lat == null ? '<span class="badge orange">sem coordenada</span>' : ''}
          <div class="small">${esc([a.street, a.number, a.complement, a.district, a.city].filter(Boolean).join(', '))}</div>
          ${a.reference ? `<div class="small muted">Ref.: ${esc(a.reference)}</div>` : ''}
        </div>
        <button class="icon-btn" data-deladdr="${a.id}" title="Remover">✕</button>
      </div>`).join('') : '<div class="muted small">Nenhum endereço salvo.</div>'}</div>
    <h4 class="mb">Últimos pedidos</h4>
    <div class="table-wrap">${customer.orders.length ? `<table>
      <thead><tr><th>Código</th><th>Data</th><th>Status</th><th class="num">Total</th></tr></thead>
      <tbody>${customer.orders.map((o) => `<tr><td class="mono">${esc(o.code)}</td><td class="small">${dateTime(o.created_at)}</td>
        <td>${statusBadge(o.status)}</td><td class="num">${money(o.total_cents)}</td></tr>`).join('')}</tbody></table>`
      : '<div class="muted small">Sem pedidos.</div>'}</div>`;

  body.querySelector('#addAddress').onclick = async () => {
    const saved = await addressDialog(customer.id);
    if (saved) { document.querySelector('.modal-scrim')?.remove(); detail(container, id); }
  };
  body.querySelectorAll('[data-deladdr]').forEach((b) => {
    b.onclick = async () => {
      if (!await confirmDialog('Remover este endereço?')) return;
      await api.del(`/api/addresses/${b.dataset.deladdr}`);
      document.querySelector('.modal-scrim')?.remove();
      detail(container, id);
    };
  });

  await modal({ title: `${customer.name} · ${customer.phone_formatted}`, body, wide: true, actions: [{ label: 'Fechar', className: 'btn-ghost' }] });
}

async function editDialog(container, customer) {
  const form = document.createElement('div');
  form.innerHTML = `
    <div class="grid cols-2">
      <div class="field"><label>Nome</label><input id="name" value="${esc(customer?.name || '')}"></div>
      <div class="field"><label>Telefone</label><input id="phone" value="${esc(customer?.phone || '')}" placeholder="21999990000"></div>
      <div class="field"><label>E-mail</label><input id="email" value="${esc(customer?.email || '')}"></div>
      <div class="field"><label class="checkbox"><input type="checkbox" id="blocked" ${customer?.blocked ? 'checked' : ''}> Bloquear novos pedidos</label></div>
      <div class="field" style="grid-column:span 2"><label>Observações</label><textarea id="notes">${esc(customer?.notes || '')}</textarea></div>
    </div>`;
  const saved = await modal({
    title: customer ? `Editar ${customer.name}` : 'Novo cliente',
    body: form,
    actions: [
      { label: 'Cancelar', className: 'btn-ghost', value: false },
      {
        label: 'Salvar',
        onClick: async ({ body }) => {
          const payload = {
            name: body.querySelector('#name').value.trim(),
            phone: body.querySelector('#phone').value.trim(),
            email: body.querySelector('#email').value.trim() || null,
            notes: body.querySelector('#notes').value.trim() || null,
            blocked: body.querySelector('#blocked').checked,
          };
          if (!payload.name || !payload.phone) { toast('Nome e telefone são obrigatórios', 'warn'); return false; }
          if (customer) await api.patch(`/api/customers/${customer.id}`, payload);
          else await api.post('/api/customers', payload);
          return true;
        },
      },
    ],
  });
  if (saved) { toast('Cliente salvo', 'ok'); load(container); }
}

export async function addressDialog(customerId) {
  const form = document.createElement('div');
  form.innerHTML = `
    <div class="grid cols-2">
      <div class="field"><label>Apelido</label><input id="label" placeholder="Casa, Trabalho"></div>
      <div class="field"><label>Bairro</label><input id="district"></div>
      <div class="field" style="grid-column:span 2"><label>Rua</label><input id="street"></div>
      <div class="field"><label>Número</label><input id="number"></div>
      <div class="field"><label>Complemento</label><input id="complement"></div>
      <div class="field" style="grid-column:span 2"><label>Referência</label><input id="reference"></div>
    </div>
    <div class="hint">As coordenadas são buscadas automaticamente para entrar na otimização de rotas.</div>`;
  return modal({
    title: 'Novo endereço',
    body: form,
    actions: [
      { label: 'Cancelar', className: 'btn-ghost', value: false },
      {
        label: 'Salvar endereço',
        onClick: async ({ body }) => {
          const payload = {};
          for (const field of ['label', 'street', 'number', 'complement', 'district', 'reference']) {
            payload[field] = body.querySelector(`#${field}`).value.trim();
          }
          if (!payload.street) { toast('Informe a rua', 'warn'); return false; }
          await api.post(`/api/customers/${customerId}/addresses`, payload);
          return true;
        },
      },
    ],
  });
}
