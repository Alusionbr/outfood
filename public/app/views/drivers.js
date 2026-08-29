/** Entregadores: cadastro, turno, comissão e fechamento do dia. */
import { api } from '../api.js';
import { refreshReference } from '../store.js';
import { confirmDialog, emptyState, modal, notifyError, toast } from '../ui.js';
import { DRIVER_STATUS_META, esc, formatPhone, fromCents, money, toCents, todayISO } from '../util.js';

const COMMISSION_LABELS = {
  por_entrega: 'Valor fixo por entrega',
  percentual_taxa: '% sobre a taxa de entrega',
  percentual_pedido: '% sobre o pedido',
  diaria: 'Diária fixa',
};

export async function render(container) {
  await draw(container);
}

async function draw(container) {
  const [drivers, settlement, users] = await Promise.all([
    api.drivers(),
    api.get(`/api/drivers/settlement?day=${todayISO()}`),
    api.get('/api/users').catch(() => []),
  ]);

  container.innerHTML = `
    <div class="row mb" style="justify-content:space-between">
      <button id="new">+ Novo entregador</button>
      <span class="muted small">${drivers.filter((d) => d.active).length} ativos</span>
    </div>
    <div class="card">
      <header><h3>Equipe de entrega</h3></header>
      <div class="table-wrap">${drivers.length ? `<table>
        <thead><tr><th>Nome</th><th>Contato</th><th>Turno</th><th>Comissão</th><th class="num">Hoje</th><th></th></tr></thead>
        <tbody>${drivers.map((d) => `
          <tr class="${d.active ? '' : 'muted'}">
            <td><b>${esc(d.name)}</b> ${d.active ? '' : '<span class="badge gray">inativo</span>'}
              <div class="small muted">${esc(d.vehicle)}${d.plate ? ' · ' + esc(d.plate) : ''}${d.user_email ? ' · ' + esc(d.user_email) : ''}</div></td>
            <td class="small">${esc(formatPhone(d.phone) || '—')}</td>
            <td><span class="dot ${DRIVER_STATUS_META[d.status]?.dot}"></span> ${esc(DRIVER_STATUS_META[d.status]?.label || d.status)}</td>
            <td class="small">${esc(COMMISSION_LABELS[d.commission_type])}<div class="muted">${d.commission_type.startsWith('percentual') ? d.commission_value + '%' : money(d.commission_value)}</div></td>
            <td class="num">${d.today.delivered}/${d.today.orders}</td>
            <td class="right nowrap">
              <button class="btn-ghost btn-sm" data-edit="${d.id}">Editar</button>
              ${d.active ? `<button class="btn-danger btn-sm" data-off="${d.id}">Desativar</button>` : `<button class="btn-2 btn-sm" data-on="${d.id}">Reativar</button>`}
            </td>
          </tr>`).join('')}</tbody></table>` : emptyState('🏍️', 'Nenhum entregador cadastrado')}
      </div>
    </div>

    <div class="card">
      <header><h3>Fechamento de hoje</h3><span class="badge">${todayISO()}</span></header>
      <div class="table-wrap">${settlement.length ? `<table>
        <thead><tr><th>Entregador</th><th class="num">Entregas</th><th class="num">Km</th><th class="num">Taxas</th><th class="num">Comissão</th><th class="num">Dinheiro a acertar</th></tr></thead>
        <tbody>${settlement.map((s) => `<tr>
          <td>${esc(s.name)}</td><td class="num">${s.deliveries}</td><td class="num">${s.km}</td>
          <td class="num">${money(s.fees_cents)}</td><td class="num strong">${money(s.commission_cents)}</td>
          <td class="num">${money(s.cash_collected_cents)}</td></tr>`).join('')}
        <tr class="strong"><td>Total</td><td class="num">${settlement.reduce((a, s) => a + s.deliveries, 0)}</td>
          <td class="num">${settlement.reduce((a, s) => a + s.km, 0).toFixed(1)}</td>
          <td class="num">${money(settlement.reduce((a, s) => a + s.fees_cents, 0))}</td>
          <td class="num">${money(settlement.reduce((a, s) => a + s.commission_cents, 0))}</td>
          <td class="num">${money(settlement.reduce((a, s) => a + s.cash_collected_cents, 0))}</td></tr>
        </tbody></table>` : emptyState('💸', 'Sem entregas hoje')}
      </div>
    </div>`;

  container.querySelector('#new').onclick = () => dialog(container, null, users);
  container.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => dialog(container, drivers.find((d) => d.id === Number(b.dataset.edit)), users);
  });
  container.querySelectorAll('[data-off]').forEach((b) => {
    b.onclick = async () => {
      if (!await confirmDialog('Desativar este entregador? Ele deixa de aparecer no despacho.')) return;
      try { await api.del(`/api/drivers/${b.dataset.off}`); await refreshReference(); draw(container); } catch (err) { notifyError(err); }
    };
  });
  container.querySelectorAll('[data-on]').forEach((b) => {
    b.onclick = async () => {
      try { await api.patch(`/api/drivers/${b.dataset.on}`, { active: true }); await refreshReference(); draw(container); } catch (err) { notifyError(err); }
    };
  });
}

async function dialog(container, driver, users) {
  const free = users.filter((u) => u.role === 'entregador');
  const form = document.createElement('div');
  form.innerHTML = `
    <div class="grid cols-2">
      <div class="field"><label>Nome</label><input id="name" value="${esc(driver?.name || '')}"></div>
      <div class="field"><label>Telefone</label><input id="phone" value="${esc(driver?.phone || '')}"></div>
      <div class="field"><label>Veículo</label><select id="vehicle">
        ${['moto', 'bike', 'carro', 'a_pe'].map((v) => `<option value="${v}" ${driver?.vehicle === v ? 'selected' : ''}>${v.replace('_', ' ')}</option>`).join('')}</select></div>
      <div class="field"><label>Placa</label><input id="plate" value="${esc(driver?.plate || '')}"></div>
      <div class="field"><label>Tipo de comissão</label><select id="commission_type">
        ${Object.entries(COMMISSION_LABELS).map(([k, v]) => `<option value="${k}" ${driver?.commission_type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="field"><label>Valor da comissão</label><input id="commission_value" value="${driver ? (driver.commission_type.startsWith('percentual') ? driver.commission_value : fromCents(driver.commission_value)) : ''}" placeholder="4,00 ou 30">
        <div class="hint">Em reais para valor fixo/diária, em % para percentuais.</div></div>
      <div class="field" style="grid-column:span 2"><label>Usuário do app (opcional)</label>
        <select id="user_id"><option value="">Sem acesso ao app</option>
          ${free.map((u) => `<option value="${u.id}" ${driver?.user_id === u.id ? 'selected' : ''}>${esc(u.name)} — ${esc(u.email)}</option>`).join('')}</select>
        <div class="hint">Vincule a um usuário com perfil "entregador" para ele usar o app de rotas.</div></div>
    </div>`;

  const saved = await modal({
    title: driver ? `Editar ${driver.name}` : 'Novo entregador',
    body: form,
    actions: [
      { label: 'Cancelar', className: 'btn-ghost', value: false },
      {
        label: 'Salvar',
        onClick: async ({ body }) => {
          const type = body.querySelector('#commission_type').value;
          const rawValue = body.querySelector('#commission_value').value;
          const payload = {
            name: body.querySelector('#name').value.trim(),
            phone: body.querySelector('#phone').value.trim() || null,
            vehicle: body.querySelector('#vehicle').value,
            plate: body.querySelector('#plate').value.trim() || null,
            commission_type: type,
            commission_value: type.startsWith('percentual') ? Math.round(Number(rawValue.replace(',', '.')) || 0) : toCents(rawValue),
            user_id: body.querySelector('#user_id').value || null,
          };
          if (!payload.name) { toast('Informe o nome', 'warn'); return false; }
          if (driver) await api.patch(`/api/drivers/${driver.id}`, payload);
          else await api.post('/api/drivers', payload);
          return true;
        },
      },
    ],
  });
  if (saved) { toast('Entregador salvo', 'ok'); await refreshReference(); draw(container); }
}
