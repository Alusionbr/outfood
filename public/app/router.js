/** Roteador por hash. Cada view exporta `render(container, ctx)` e, se precisar, `destroy()`. */
const routes = new Map();
let current = null;
let container = null;
let notFoundView = null;

export function defineRoute(path, loader, options = {}) {
  routes.set(path, { loader, ...options });
}

export function setContainer(element) { container = element; }
export function setNotFound(view) { notFoundView = view; }

export function currentPath() {
  const hash = location.hash.replace(/^#/, '') || '/';
  return hash.split('?')[0];
}

export function currentQuery() {
  const hash = location.hash.replace(/^#/, '');
  const index = hash.indexOf('?');
  return new URLSearchParams(index >= 0 ? hash.slice(index + 1) : '');
}

export function navigate(path, replace = false) {
  const target = path.startsWith('#') ? path : `#${path}`;
  if (replace) location.replace(target);
  else location.hash = target;
}

// Cada render recebe um número de geração: se uma navegação mais nova começar
// enquanto o módulo da view ainda está sendo importado, o render antigo é
// abortado antes de pintar a tela (senão ele sobrescreve a view atual).
let generation = 0;

export async function renderCurrent() {
  const token = ++generation;
  const path = currentPath();
  const match = routes.get(path) || routes.get(path.replace(/\/[^/]+$/, '/:id'));
  const ctx = { path, query: currentQuery(), params: {} };
  if (!routes.get(path)) {
    const parts = path.split('/');
    ctx.params.id = parts[parts.length - 1];
  }

  if (current?.destroy) { try { current.destroy(); } catch { /* view já removida */ } }
  current = null;

  if (!match) {
    container.innerHTML = notFoundView || '<div class="empty">Página não encontrada</div>';
    return;
  }
  if (match.guard && !match.guard()) {
    container.innerHTML = '<div class="card"><div class="body empty">🔒 Seu perfil não tem acesso a esta área.</div></div>';
    return;
  }

  container.innerHTML = '<div class="loading">Carregando...</div>';
  const view = await match.loader();
  if (token !== generation) return;
  current = view;
  document.title = `${match.title || 'Outfood'} — Outfood`;
  await view.render(container, ctx);
}

export function startRouter() {
  window.addEventListener('hashchange', renderCurrent);
  return renderCurrent();
}

export function routeTitle(path) {
  return routes.get(path)?.title || '';
}
