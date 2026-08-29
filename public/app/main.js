/** Entrada do painel: login, casca da aplicação e registro das rotas. */
import { api, ApiError } from './api.js';
import { $, esc } from './util.js';
import { notifyError, toast } from './ui.js';
import {
  can, connectRealtime, disconnectRealtime, emitChange, loadSession, onChange,
  refreshCounters, refreshReference, state,
} from './store.js';
import { defineRoute, navigate, renderCurrent, setContainer, startRouter, currentPath } from './router.js';

const NAV = [
  { group: 'Operação' },
  { path: '/', icon: '📊', label: 'Painel do dia', permission: 'reports:read' },
  { path: '/pdv', icon: '🧾', label: 'Novo pedido', permission: 'orders:create' },
  { path: '/pedidos', icon: '📋', label: 'Pedidos', permission: 'orders:read', counter: 'open' },
  { path: '/cozinha', icon: '🔥', label: 'Cozinha', permission: 'kitchen:read', counter: 'kitchen' },
  { path: '/despacho', icon: '🛵', label: 'Despacho e rotas', permission: 'routes:read', counter: 'dispatch' },
  { group: 'Cadastros' },
  { path: '/cardapio', icon: '🍕', label: 'Cardápio', permission: 'menu:read' },
  { path: '/clientes', icon: '👥', label: 'Clientes', permission: 'customers:read' },
  { path: '/entregadores', icon: '🏍️', label: 'Entregadores', permission: 'drivers:read' },
  { path: '/zonas', icon: '🗺️', label: 'Zonas de entrega', permission: 'zones:read' },
  { group: 'Gestão' },
  { path: '/caixa', icon: '💰', label: 'Caixa', permission: 'cash:read' },
  { path: '/relatorios', icon: '📈', label: 'Relatórios', permission: 'reports:read' },
  { path: '/usuarios', icon: '🔑', label: 'Usuários', permission: 'users:read' },
  { path: '/config', icon: '⚙️', label: 'Configurações', permission: 'settings:read' },
];

const VIEWS = {
  '/': { load: () => import('./views/dashboard.js'), title: 'Painel do dia', permission: 'reports:read' },
  '/pdv': { load: () => import('./views/pdv.js'), title: 'Novo pedido', permission: 'orders:create' },
  '/pedidos': { load: () => import('./views/orders.js'), title: 'Pedidos', permission: 'orders:read' },
  '/cozinha': { load: () => import('./views/kitchen.js'), title: 'Cozinha', permission: 'kitchen:read' },
  '/despacho': { load: () => import('./views/dispatch.js'), title: 'Despacho e rotas', permission: 'routes:read' },
  '/cardapio': { load: () => import('./views/menu.js'), title: 'Cardápio', permission: 'menu:read' },
  '/clientes': { load: () => import('./views/customers.js'), title: 'Clientes', permission: 'customers:read' },
  '/entregadores': { load: () => import('./views/drivers.js'), title: 'Entregadores', permission: 'drivers:read' },
  '/zonas': { load: () => import('./views/zones.js'), title: 'Zonas de entrega', permission: 'zones:read' },
  '/caixa': { load: () => import('./views/cash.js'), title: 'Caixa', permission: 'cash:read' },
  '/relatorios': { load: () => import('./views/reports.js'), title: 'Relatórios', permission: 'reports:read' },
  '/usuarios': { load: () => import('./views/users.js'), title: 'Usuários', permission: 'users:read' },
  '/config': { load: () => import('./views/settings.js'), title: 'Configurações', permission: 'settings:read' },
};

/* ------------------------------- login ------------------------------- */

function renderLogin(message = '') {
  document.getElementById('root').innerHTML = `
    <div class="login-page">
      <form class="login-card" id="loginForm">
        <div class="logo">🛵</div>
        <h1>Outfood</h1>
        <p>Gestão de pedidos e entregas do seu restaurante.</p>
        ${message ? `<div class="toast err" style="position:static;margin-bottom:14px">${esc(message)}</div>` : ''}
        <div class="field"><label for="email">E-mail</label>
          <input type="email" id="email" name="email" autocomplete="username" required autofocus></div>
        <div class="field"><label for="password">Senha</label>
          <input type="password" id="password" name="password" autocomplete="current-password" required></div>
        <button class="btn-lg btn-block" type="submit" id="loginBtn">Entrar</button>
        <div class="login-hint">
          <b>Primeiro acesso?</b> Use <code>admin@outfood.local</code> com a senha definida em
          <code>OUTFOOD_ADMIN_PASSWORD</code> (padrão <code>outfood123</code>) e troque em Configurações.
        </div>
      </form>
    </div>`;

  $('#loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('#loginBtn');
    button.disabled = true;
    button.textContent = 'Entrando...';
    try {
      await api.login($('#email').value.trim(), $('#password').value);
      await boot();
    } catch (err) {
      renderLogin(err.message);
    }
  });
}

/* ------------------------------- casca ------------------------------- */

function renderShell() {
  document.getElementById('root').innerHTML = `
    <div class="shell">
      <aside class="sidebar" id="sidebar">
        <div class="brand">
          <div class="logo">🛵</div>
          <div><b>${esc(state.settings.store_name || 'Outfood')}</b><small>Gestão de entregas</small></div>
        </div>
        <nav class="nav" id="nav"></nav>
        <div class="foot">
          <div class="who">${esc(state.user.name)}</div>
          <div>${esc(roleLabel(state.user.role))}</div>
          <button class="btn-ghost btn-sm" id="logout" style="margin-top:8px;width:100%">Sair</button>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <button class="btn-ghost btn-sm menu-toggle" id="menuToggle" aria-label="Menu">☰</button>
          <div class="title" id="pageTitle">Painel</div>
          <div class="row tight" id="topActions"></div>
          <span class="badge" id="conn" title="Conexão em tempo real"><span class="dot"></span> conectando</span>
        </header>
        <main class="content" id="view"></main>
      </div>
    </div>`;

  setContainer($('#view'));
  $('#logout').onclick = async () => {
    disconnectRealtime();
    await api.logout().catch(() => {});
    state.user = null;
    renderLogin();
  };
  $('#menuToggle').onclick = () => {
    const sidebar = $('#sidebar');
    sidebar.classList.toggle('open');
    if (sidebar.classList.contains('open')) {
      const scrim = document.createElement('div');
      scrim.className = 'scrim';
      scrim.onclick = () => { sidebar.classList.remove('open'); scrim.remove(); };
      document.body.appendChild(scrim);
    } else {
      document.querySelector('.scrim')?.remove();
    }
  };
  renderNav();
}

function renderNav() {
  const nav = $('#nav');
  if (!nav) return;
  const path = currentPath();
  nav.innerHTML = NAV.map((item) => {
    if (item.group) return `<div class="group">${esc(item.group)}</div>`;
    if (item.permission && !can(item.permission)) return '';
    const count = item.counter ? state.counters[item.counter] : 0;
    return `<a href="#${item.path}" class="${path === item.path ? 'active' : ''}">
      <span class="ico">${item.icon}</span><span>${esc(item.label)}</span>
      ${count ? `<span class="count">${count}</span>` : ''}
    </a>`;
  }).join('');
  nav.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', () => {
      $('#sidebar')?.classList.remove('open');
      document.querySelector('.scrim')?.remove();
    });
  });
}

function updateTopbar() {
  const title = $('#pageTitle');
  if (title) title.textContent = VIEWS[currentPath()]?.title || 'Outfood';
  const conn = $('#conn');
  if (conn) {
    conn.innerHTML = state.connected
      ? '<span class="dot on"></span> ao vivo'
      : '<span class="dot off"></span> reconectando';
    conn.className = `badge ${state.connected ? 'green' : 'red'}`;
  }
}

function roleLabel(role) {
  return { admin: 'Administrador', gerente: 'Gerente', atendente: 'Atendente', cozinha: 'Cozinha', entregador: 'Entregador' }[role] || role;
}

/* ------------------------------- boot ------------------------------- */

async function boot() {
  try {
    await loadSession();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return renderLogin();
    return renderLogin(err.message);
  }

  await refreshReference();
  renderShell();

  for (const [path, view] of Object.entries(VIEWS)) {
    defineRoute(path, view.load, { title: view.title, guard: () => !view.permission || can(view.permission) });
  }

  onChange(() => { renderNav(); updateTopbar(); });
  connectRealtime();
  refreshCounters();
  setInterval(refreshCounters, 60000);

  // O entregador entra direto no app de rota, que é feito para celular.
  if (state.user.role === 'entregador') { location.href = '/entregador'; return; }

  const first = firstAllowedPath();
  if (!location.hash || !VIEWS[currentPath()]) navigate(first, true);
  await startRouter();
  updateTopbar();
  window.addEventListener('hashchange', updateTopbar);
}

function firstAllowedPath() {
  for (const item of NAV) {
    if (item.group) continue;
    if (!item.permission || can(item.permission)) return item.path;
  }
  return '/pedidos';
}

window.addEventListener('unhandledrejection', (event) => {
  if (event.reason instanceof ApiError && event.reason.status === 401) {
    disconnectRealtime();
    renderLogin('Sua sessão expirou. Entre novamente.');
    event.preventDefault();
  }
});

boot();
export { renderCurrent, toast, notifyError, emitChange };
