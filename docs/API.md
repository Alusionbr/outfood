# API do Outfood

Base: `/api`. Tudo em JSON, UTF-8. A sessão viaja num cookie `outfood_session`
(HttpOnly) ou no cabeçalho `Authorization: Bearer <token>`.

Erros seguem sempre o mesmo formato:

```json
{ "error": "Mensagem em português", "details": { "…": "opcional" } }
```

| Status | Quando |
| --- | --- |
| 400 | Dado inválido ou faltando |
| 401 | Sem sessão |
| 403 | Perfil sem permissão para a ação |
| 404 | Registro inexistente |
| 405 | Método errado para o endereço |
| 409 | Conflito de estado (transição inválida, caixa já aberto, pedido já roteirizado) |

Valores monetários são **inteiros em centavos** (`total_cents: 10500` = R$ 105,00).

---

## Autenticação

| Método | Rota | Descrição |
| --- | --- | --- |
| `POST` | `/auth/login` | `{ email, password }` → usuário + permissões, grava o cookie |
| `POST` | `/auth/logout` | Encerra a sessão |
| `GET` | `/auth/me` | Usuário logado, permissões e configurações da loja |
| `POST` | `/auth/password` | `{ current_password, new_password }` (derruba as outras sessões) |

## Usuários e configurações

| Método | Rota | Permissão |
| --- | --- | --- |
| `GET` `POST` | `/users` | `users:read` / `users:create` |
| `PATCH` `DELETE` | `/users/:id` | `users:update` / `users:delete` |
| `GET` `PUT` | `/settings` | `settings:read` / `settings:update` |
| `GET` | `/audit` | `settings:update` |

## Cardápio

| Método | Rota | Descrição |
| --- | --- | --- |
| `GET` | `/menu` | Categorias com produtos, adicionais e disponibilidade |
| `GET` `POST` | `/categories` | Lista / cria |
| `PATCH` `DELETE` | `/categories/:id` | Edita / exclui |
| `GET` `POST` | `/products` | `?q=` busca por nome ou SKU |
| `PATCH` `DELETE` | `/products/:id` | Produto com histórico é desativado, não excluído |
| `POST` | `/products/:id/stock` | `{ stock_qty }` — liga o controle de estoque |

## Clientes

| Método | Rota | Descrição |
| --- | --- | --- |
| `GET` | `/customers` | `?q=` nome ou telefone |
| `GET` | `/customers/lookup?phone=` | Busca do PDV: devolve cliente + endereços |
| `GET` | `/customers/:id` | Ficha com endereços e últimos pedidos |
| `POST` `PATCH` `DELETE` | `/customers[/:id]` | Cliente com pedidos não é excluído — use `blocked` |
| `POST` | `/customers/:id/addresses` | Geocodifica sozinho quando falta lat/lon |
| `PATCH` `DELETE` | `/addresses/:id` | |
| `GET` | `/geo/search?q=` | Geocodificação (Nominatim, com cache em banco) |

## Pedidos

| Método | Rota | Descrição |
| --- | --- | --- |
| `GET` | `/orders` | Filtros: `status`, `open=1`, `day`, `from`/`to`, `driver_id`, `customer_id`, `route_id`, `type`, `channel`, `unassigned=1`, `q`, `limit` |
| `GET` | `/orders/:id` | Pedido completo: itens, pagamentos e linha do tempo |
| `POST` | `/orders` | Cria (veja o corpo abaixo) |
| `PATCH` | `/orders/:id` | Edita; recalcula os totais. Recusa pedido entregue ou cancelado |
| `POST` | `/orders/:id/status` | `{ status, reason? }` — respeita a máquina de estados |
| `POST` | `/orders/:id/payments` | `{ method, amount_cents, received_cents? }`, calcula o troco |
| `POST` | `/orders/:id/geocode` | Tenta localizar o endereço no mapa |
| `GET` | `/kitchen` | Fila da cozinha, com marcação de atraso |
| `GET` | `/today` | Pedidos do dia comercial |

### Corpo de `POST /orders`

```jsonc
{
  "customer_name": "Ana Paula",
  "customer_phone": "21988887777",   // cadastra o cliente se não existir
  "customer_id": 12,                  // ou use um cliente existente
  "type": "entrega",                  // entrega | retirada | salao
  "channel": "telefone",              // balcao telefone whatsapp site ifood rappi outra_plataforma
  "courier": "loja",                  // loja | plataforma (plataforma fica fora da roteirização)
  "address_id": 3,                    // ou os campos soltos abaixo
  "street": "Rua Cardoso de Castro", "number": "250",
  "complement": "Apto 201", "district": "Anchieta", "reference": "Perto da praça",
  "lat": -22.8261, "lon": -43.4019,   // opcional: geocodifica sozinho se faltar
  "save_address": true,
  "items": [
    { "product_id": 1, "qty": 2, "notes": "sem cebola",
      "options": [{ "id": 4 }] }
  ],
  "delivery_fee_cents": 500,          // opcional: sobrepõe a política de taxa
  "discount_cents": 0,
  "payment_method": "dinheiro",       // dinheiro pix credito debito vale_refeicao online
  "change_for_cents": 15000,
  "paid": false,
  "notes": "Interfone quebrado"
}
```

**Status possíveis:** `rascunho`, `recebido`, `em_preparo`, `pronto`,
`em_entrega`, `entregue`, `cancelado`.

```
recebido ──▶ em_preparo ──▶ pronto ──▶ em_entrega ──▶ entregue
    └──────────────┴───────────┴────────────┴──▶ cancelado
```

Retirada e pedido de plataforma vão de `pronto` direto para `entregue`.
Entrega própria exige entregador definido antes de `em_entrega`.

## Entregadores

| Método | Rota | Descrição |
| --- | --- | --- |
| `GET` | `/drivers` | `?active=1` |
| `GET` | `/drivers/me` | Entregador logado + rotas do dia (usado pelo app) |
| `POST` `PATCH` `DELETE` | `/drivers[/:id]` | Exclusão desativa, preservando o histórico |
| `POST` | `/drivers/:id/status` | `{ status }` — `offline`, `na_loja`, `em_rota` |
| `POST` | `/drivers/:id/ping` | `{ lat, lon }` — posição no mapa do despacho |
| `GET` | `/drivers/settlement?day=` | Entregas, km, taxas e comissão por entregador |

Comissão: `por_entrega` (valor fixo), `percentual_taxa`, `percentual_pedido`,
`diaria`.

## Despacho e rotas

| Método | Rota | Descrição |
| --- | --- | --- |
| `GET` | `/dispatch/queue` | Fila + entregadores + rotas ativas (uma chamada só) |
| `POST` | `/dispatch/auto` | `{ driver_ids?, order_ids?, max_per_driver? }` — divide por setor |
| `POST` | `/dispatch/scan` | `{ code, driver_id? }` — leitura do QR da comanda |
| `GET` | `/routes` | `?day=`, `?driver_id=`, `?status=`, `?all=1` |
| `GET` | `/routes/:id` | Rota com paradas, `maps_url` e `waze_url` por parada |
| `POST` | `/routes` | `{ driver_id, order_ids }` — cria já otimizada |
| `POST` | `/routes/:id/start` | Inicia: entregador em rota, pedidos em entrega |
| `POST` | `/routes/:id/optimize` | Reotimiza a partir da posição atual do entregador |
| `POST` | `/routes/:id/reorder` | `{ order_ids }` — ordem manual |
| `POST` | `/routes/:id/orders` | `{ order_id }` — encaixe de última hora |
| `POST` | `/routes/:id/merge` | `{ source_route_id }` — junta duas rotas e reotimiza |
| `POST` | `/routes/:id/cancel` | Devolve os pedidos pendentes para a fila |
| `POST` | `/routes/:id/stops/:orderId` | `{ failed?, reason? }` — conclui ou marca insucesso |

### Navegação

Cada parada devolve `waze_url` (um destino por vez, formato universal do Waze) e
a rota devolve `maps_url` (Google Maps com todas as paradas). O QR Code é gerado
no navegador a partir desses links — veja `public/app/navigation.js`.

O QR impresso na comanda carrega `OUTFOOD:PEDIDO:<código>`; `POST /dispatch/scan`
aceita esse texto ou o código puro (`0829-014`).

## Zonas

`GET` `POST` `/zones`, `PATCH` `DELETE` `/zones/:id` — nome, cor, `lat`/`lon`,
`radius_km`, `fee_cents`, `min_order_cents`, entregador preferencial.

## Caixa e relatórios

| Método | Rota | Descrição |
| --- | --- | --- |
| `GET` | `/cash?day=` | Resumo por forma de pagamento, esperado na gaveta, comissões |
| `GET` | `/cash/current` `/cash/sessions` | Caixa aberto / histórico |
| `POST` | `/cash/open` | `{ opening_float_cents, notes? }` |
| `POST` | `/cash/close` | `{ counted_cents, notes? }` → grava a diferença |
| `GET` | `/reports/dashboard?day=` | Indicadores do dia, por hora, canal, bairro, produto |
| `GET` | `/reports/sales?from=&to=` | Série diária de faturamento |
| `GET` | `/reports/products` `/reports/customers` | Rankings |
| `GET` | `/reports/orders.csv?from=&to=` | Exportação para planilha (`;`, com BOM) |

## Impressão

`GET /print/order/:id/kitchen`, `/print/order/:id/receipt`, `/print/route/:id`,
`/print/cash?day=` — devolvem `{ text }` já formatado para a largura configurada
(58 mm ou 80 mm). O navegador acrescenta o QR Code e manda para a impressora.

## Endpoints públicos (sem login)

| Método | Rota | Descrição |
| --- | --- | --- |
| `GET` | `/health` | Healthcheck |
| `GET` | `/public/store` | Dados da loja para a vitrine |
| `GET` | `/public/menu` | Cardápio ativo e disponível |
| `POST` | `/public/orders` | Pedido da vitrine online |
| `GET` | `/public/track/:token` | Acompanhamento do pedido |
| `POST` | `/public/track/:token/rating` | `{ rating: 1..5, comment? }` |

`POST /public/orders` **descarta** qualquer preço, taxa, desconto, status ou
canal enviado pelo navegador: o servidor relê tudo do cardápio e recalcula. O
`token` do rastreio é aleatório e o retorno não expõe id interno, telefone,
custo nem observação interna do pedido.

## Tempo real (SSE)

`GET /api/events` — fluxo autenticado de eventos:

`order:created`, `order:updated`, `order:status`, `order:rated`,
`route:created`, `route:started`, `route:updated`, `route:merged`,
`route:finished`, `route:cancelled`, `driver:status`, `driver:position`,
`driver:updated`, `dispatch:auto`, `menu:updated`, `zones:updated`.

```js
const source = new EventSource('/api/events');
source.addEventListener('order:created', (e) => console.log(JSON.parse(e.data).order.code));
```
