/** Usuários e perfis de acesso. */
import { api } from '../api.js';
import { can, state } from '../store.js';
import { confirmDialog, emptyState, modal, notifyError, toast } from '../ui.js';
import { dateTime, esc, formatPhone } from '../util.js';

const ROLES = {
  admin: 'Administrador — acesso total',
  gerente: 'Gerente — operação, cardápio e relatórios',
  atendente: 'Atendente — pedidos, clientes e caixa',
  cozinha: 'Cozinha — apenas a fila de produção',
  entregador: 'Entregador — app de rotas no celular',
};

export async function render(container) {
  await draw(container);
}

async function draw(container) {
  const users = await api.get('/api/users');
  container.innerHTML = `
    <div class="row mb" style="justify-content:space-between">
      ${can('users:create') ? '<button id="new">+ Novo usuário</button>' : '<span></span>'}
      <button class="btn-ghost" id="password">Trocar minha senha</button>
    </div>
    <div class="card">
      <header><h3>Usuários</h3><span class="badge">${users.filter((u) => u.active).length} ativos</span></header>
      <div class="table-wrap">${users.length ? `<table>
        <thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Criado em</th><th></th></tr></thead>
        <tbody>${users.map((u) => `<tr>
          <td><b>${esc(u.name)}</b>${u.id === state.user.id ? ' <span class="badge green">você</span>' : ''}
            ${u.active ? '' : ' <span class="badge gray">inativo</span>'}
            ${u.phone ? `<div class="small muted">${esc(formatPhone(u.phone))}</div>` : ''}</td>
          <td class="small">${esc(u.email)}</td>
          <td class="small">${esc((ROLES[u.role] || u.role).split(' — ')[0])}</td>
          <td class="small muted">${dateTime(u.created_at)}</td>
          <td class="right nowrap">${can('users:update') ? `<button class="btn-ghost btn-sm" data-edit="${u.id}">Editar</button>` : ''}
            ${can('users:delete') && u.id !== state.user.id && u.active ? `<button class="btn-danger btn-sm" data-del="${u.id}">Desativar</button>` : ''}</td>
        </tr>`).join('')}</tbody></table>` : emptyState('🔑', 'Nenhum usuário')}
      </div>
    </div>
    <div class="card"><div class="body">
      <h4 class="mb">O que cada perfil enxerga</h4>
      ${Object.entries(ROLES).map(([k, v]) => `<div class="small" style="padding:3px 0"><b>${esc(v.split(' — ')[0])}</b> — ${esc(v.split(' — ')[1])}</div>`).join('')}
    </div></div>`;

  container.querySelector('#new')?.addEventListener('click', () => dialog(container, null));
  container.querySelector('#password').onclick = () => passwordDialog();
  container.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => dialog(container, users.find((u) => u.id === Number(b.dataset.edit)));
  });
  container.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!await confirmDialog('Desativar este usuário? Ele perde o acesso imediatamente.')) return;
      try { await api.del(`/api/users/${b.dataset.del}`); toast('Usuário desativado', 'ok'); draw(container); } catch (err) { notifyError(err); }
    };
  });
}

async function dialog(container, user) {
  const form = document.createElement('div');
  form.innerHTML = `
    <div class="grid cols-2">
      <div class="field"><label>Nome</label><input id="name" value="${esc(user?.name || '')}"></div>
      <div class="field"><label>E-mail</label><input type="email" id="email" value="${esc(user?.email || '')}"></div>
      <div class="field"><label>Telefone</label><input id="phone" value="${esc(user?.phone || '')}"></div>
      <div class="field"><label>Perfil</label><select id="role">
        ${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${user?.role === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
      <div class="field" style="grid-column:span 2"><label>${user ? 'Nova senha (deixe vazio para manter)' : 'Senha'}</label>
        <input type="password" id="password" autocomplete="new-password"></div>
      ${user ? `<div class="field"><label class="checkbox"><input type="checkbox" id="active" ${user.active ? 'checked' : ''}> Usuário ativo</label></div>` : ''}
    </div>
    <div class="hint">Ao criar um usuário com perfil "entregador", o cadastro na equipe de entrega é criado junto.</div>`;

  const saved = await modal({
    title: user ? `Editar ${user.name}` : 'Novo usuário',
    body: form,
    actions: [
      { label: 'Cancelar', className: 'btn-ghost', value: false },
      {
        label: 'Salvar',
        onClick: async ({ body }) => {
          const payload = {
            name: body.querySelector('#name').value.trim(),
            email: body.querySelector('#email').value.trim(),
            phone: body.querySelector('#phone').value.trim() || null,
            role: body.querySelector('#role').value,
          };
          const password = body.querySelector('#password').value;
          if (password) payload.password = password;
          if (user) {
            payload.active = body.querySelector('#active').checked;
            await api.patch(`/api/users/${user.id}`, payload);
          } else {
            if (!password) { toast('Defina a senha inicial', 'warn'); return false; }
            await api.post('/api/users', payload);
          }
          return true;
        },
      },
    ],
  });
  if (saved) { toast('Usuário salvo', 'ok'); draw(container); }
}

async function passwordDialog() {
  const form = document.createElement('div');
  form.innerHTML = `
    <div class="field"><label>Senha atual</label><input type="password" id="current" autocomplete="current-password"></div>
    <div class="field"><label>Nova senha</label><input type="password" id="next" autocomplete="new-password"></div>
    <div class="hint">Ao trocar a senha, as outras sessões abertas são encerradas.</div>`;
  const done = await modal({
    title: 'Trocar minha senha',
    body: form,
    actions: [
      { label: 'Cancelar', className: 'btn-ghost', value: false },
      {
        label: 'Trocar senha',
        onClick: async ({ body }) => {
          await api.post('/api/auth/password', {
            current_password: body.querySelector('#current').value,
            new_password: body.querySelector('#next').value,
          });
          return true;
        },
      },
    ],
  });
  if (done) toast('Senha alterada', 'ok');
}
