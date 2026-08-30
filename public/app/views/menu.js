/** Cardápio: categorias, produtos, adicionais e controle simples de estoque. */
import { api } from '../api.js';
import { can, refreshReference } from '../store.js';
import { confirmDialog, emptyState, modal, notifyError, toast } from '../ui.js';
import { esc, fromCents, money, toCents } from '../util.js';

export async function render(container) {
  await draw(container);
}

async function draw(container) {
  const [menu, categories] = await Promise.all([api.menu(), api.get('/api/categories')]);
  const canWrite = can('menu:create') || can('menu:update');
  const canDelete = can('menu:delete');
  container.innerHTML = `
    <div class="row mb" style="justify-content:space-between">
      <div class="row tight">
        ${can('menu:create') ? '<button id="newProduct">+ Novo produto</button><button class="btn-2" id="newCategory">+ Nova categoria</button>' : ''}
      </div>
      <span class="muted small">${menu.reduce((acc, c) => acc + c.products.length, 0)} produtos em ${categories.length} categorias</span>
    </div>
    ${menu.length ? menu.map((category) => `
      <div class="card">
        <header>
          <h3>${esc(category.name)}</h3>
          <span class="badge">${category.products.length} itens</span>
          ${category.id && (canWrite || canDelete) ? `<div class="row tight" style="margin-left:auto">
            ${canWrite ? `<button class="btn-ghost btn-sm" data-editcat="${category.id}">Renomear</button>` : ''}
            ${canDelete ? `<button class="btn-danger btn-sm" data-delcat="${category.id}">Excluir</button>` : ''}
          </div>` : ''}
        </header>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Produto</th><th>Adicionais</th><th class="num">Preço</th><th class="num">Preparo</th><th class="num">Estoque</th><th>Status</th><th></th></tr></thead>
            <tbody>${category.products.map((p) => `
              <tr>
                <td><b>${esc(p.name)}</b>${p.description ? `<div class="small muted">${esc(p.description)}</div>` : ''}</td>
                <td class="small muted">${p.options.length ? p.options.map((o) => esc(o.name)).join(', ') : '—'}</td>
                <td class="num strong">${money(p.price_cents)}</td>
                <td class="num">${p.prep_minutes} min</td>
                <td class="num">${p.stock_control ? `<span class="badge ${p.stock_qty > 0 ? 'green' : 'red'}">${p.stock_qty}</span>` : '—'}</td>
                <td>${p.active ? '<span class="badge green">ativo</span>' : '<span class="badge gray">inativo</span>'}</td>
                <td class="right nowrap">
                  ${canWrite ? `<button class="btn-ghost btn-sm" data-edit="${p.id}">Editar</button>` : ''}
                  ${canDelete ? `<button class="btn-danger btn-sm" data-del="${p.id}">Excluir</button>` : ''}
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`).join('') : emptyState('🍕', 'Cardápio vazio', 'Crie uma categoria e adicione seus produtos.')}`;

  const all = menu.flatMap((c) => c.products);
  container.querySelector('#newProduct')?.addEventListener('click', () => productDialog(container, null, categories));
  container.querySelector('#newCategory')?.addEventListener('click', () => categoryDialog(container, null));
  container.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => productDialog(container, all.find((p) => p.id === Number(b.dataset.edit)), categories);
  });
  container.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      const product = all.find((p) => p.id === Number(b.dataset.del));
      if (!await confirmDialog(`Excluir "${product.name}"? Produtos com histórico são apenas desativados.`)) return;
      try {
        const result = await api.del(`/api/products/${product.id}`);
        toast(result.deactivated ? 'Produto desativado (tem histórico de vendas)' : 'Produto excluído', 'ok');
        await refreshReference();
        draw(container);
      } catch (err) { notifyError(err); }
    };
  });
  container.querySelectorAll('[data-editcat]').forEach((b) => {
    b.onclick = () => categoryDialog(container, categories.find((c) => c.id === Number(b.dataset.editcat)));
  });
  container.querySelectorAll('[data-delcat]').forEach((b) => {
    b.onclick = async () => {
      if (!await confirmDialog('Excluir a categoria? Os produtos ficam sem categoria.')) return;
      try { await api.del(`/api/categories/${b.dataset.delcat}`); draw(container); } catch (err) { notifyError(err); }
    };
  });
}

async function categoryDialog(container, category) {
  const form = document.createElement('div');
  form.innerHTML = `
    <div class="field"><label>Nome da categoria</label><input id="name" value="${esc(category?.name || '')}" placeholder="Pizzas"></div>
    <div class="field"><label>Ordem de exibição</label><input type="number" id="sort" value="${category?.sort ?? 0}"></div>`;
  const saved = await modal({
    title: category ? 'Editar categoria' : 'Nova categoria',
    body: form,
    actions: [
      { label: 'Cancelar', className: 'btn-ghost', value: false },
      {
        label: 'Salvar',
        onClick: async ({ body }) => {
          const payload = { name: body.querySelector('#name').value.trim(), sort: Number(body.querySelector('#sort').value) };
          if (!payload.name) return false;
          if (category) await api.patch(`/api/categories/${category.id}`, payload);
          else await api.post('/api/categories', payload);
          return true;
        },
      },
    ],
  });
  if (saved) { toast('Categoria salva', 'ok'); await refreshReference(); draw(container); }
}

async function productDialog(container, product, categories) {
  const form = document.createElement('div');
  form.innerHTML = `
    <div class="grid cols-2">
      <div class="field" style="grid-column:span 2"><label>Nome</label><input id="name" value="${esc(product?.name || '')}" placeholder="Pizza Calabresa"></div>
      <div class="field" style="grid-column:span 2"><label>Descrição</label><input id="description" value="${esc(product?.description || '')}" placeholder="Calabresa, cebola e azeitona"></div>
      <div class="field"><label>Categoria</label><select id="category_id"><option value="">Sem categoria</option>
        ${categories.map((c) => `<option value="${c.id}" ${product?.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Preço de venda (R$)</label><input id="price" value="${product ? fromCents(product.price_cents) : ''}" placeholder="52,00"></div>
      <div class="field"><label>Custo (R$)</label><input id="cost" value="${product ? fromCents(product.cost_cents) : ''}" placeholder="19,00"></div>
      <div class="field"><label>Tempo de preparo (min)</label><input type="number" id="prep_minutes" value="${product?.prep_minutes ?? 15}"></div>
      <div class="field"><label class="checkbox"><input type="checkbox" id="active" ${product?.active !== false ? 'checked' : ''}> Disponível para venda</label></div>
      <div class="field"><label class="checkbox"><input type="checkbox" id="stock_control" ${product?.stock_control ? 'checked' : ''}> Controlar estoque</label>
        <input type="number" id="stock_qty" value="${product?.stock_qty ?? 0}" placeholder="quantidade"></div>
    </div>
    <div class="sep"></div>
    <div class="spread"><h4>Adicionais</h4><button class="btn-2 btn-sm" id="addOption">+ Adicional</button></div>
    <div id="options" class="mt"></div>`;

  const options = (product?.options || []).map((o) => ({ ...o }));
  const renderOptions = () => {
    const host = form.querySelector('#options');
    host.innerHTML = options.length ? options.map((o, i) => `
      <div class="row tight mb">
        <input value="${esc(o.group_name || 'Adicionais')}" data-field="group_name" data-i="${i}" placeholder="Grupo" style="width:110px">
        <input value="${esc(o.name)}" data-field="name" data-i="${i}" placeholder="Bacon extra" class="grow">
        <input value="${fromCents(o.price_cents)}" data-field="price" data-i="${i}" placeholder="0,00" style="width:90px">
        <button class="icon-btn" data-rm="${i}">✕</button>
      </div>`).join('') : '<div class="muted small">Sem adicionais.</div>';
    host.querySelectorAll('[data-field]').forEach((input) => {
      input.oninput = () => {
        const item = options[Number(input.dataset.i)];
        if (input.dataset.field === 'price') item.price_cents = toCents(input.value);
        else item[input.dataset.field] = input.value;
      };
    });
    host.querySelectorAll('[data-rm]').forEach((b) => {
      b.onclick = () => { options.splice(Number(b.dataset.rm), 1); renderOptions(); };
    });
  };
  form.querySelector('#addOption').onclick = () => { options.push({ group_name: 'Adicionais', name: '', price_cents: 0 }); renderOptions(); };
  renderOptions();

  const saved = await modal({
    title: product ? `Editar ${product.name}` : 'Novo produto',
    body: form,
    wide: true,
    actions: [
      { label: 'Cancelar', className: 'btn-ghost', value: false },
      {
        label: 'Salvar produto',
        onClick: async ({ body }) => {
          const payload = {
            name: body.querySelector('#name').value.trim(),
            description: body.querySelector('#description').value.trim(),
            category_id: body.querySelector('#category_id').value || null,
            price_cents: toCents(body.querySelector('#price').value),
            cost_cents: toCents(body.querySelector('#cost').value),
            prep_minutes: Number(body.querySelector('#prep_minutes').value) || 10,
            active: body.querySelector('#active').checked,
            stock_control: body.querySelector('#stock_control').checked,
            stock_qty: Number(body.querySelector('#stock_qty').value) || 0,
            options: options.filter((o) => o.name.trim()),
          };
          if (!payload.name) { toast('Informe o nome do produto', 'warn'); return false; }
          if (product) await api.patch(`/api/products/${product.id}`, payload);
          else await api.post('/api/products', payload);
          return true;
        },
      },
    ],
  });
  if (saved) { toast('Produto salvo', 'ok'); await refreshReference(); draw(container); }
}
