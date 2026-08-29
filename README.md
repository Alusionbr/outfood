# Outfood

Sistema completo de gestão de pedidos e entregas para restaurantes: PDV, cozinha,
roteirização com mapa, app do entregador, vitrine online, caixa e relatórios.

Roda com **zero dependências de produção** — só Node.js 22+ e o SQLite embutido
(`node:sqlite`). Nenhum build, nenhum framework, nenhum serviço externo obrigatório.

```bash
npm run seed     # cria o banco com dados de exemplo
npm start        # http://localhost:3000
```

Acesso inicial: `admin@outfood.local` / `outfood123` (troque em Configurações).

---

## O que o sistema faz

| Área | O que resolve |
| --- | --- |
| **PDV** (`/#/pdv`) | Lança o pedido numa tela só: acha o cliente pelo telefone, recupera o endereço salvo, monta o carrinho com adicionais, calcula a taxa e imprime a comanda. |
| **Cozinha** (`/#/cozinha`) | KDS em três colunas (novos → em preparo → prontos), com contagem de atraso contra a promessa de entrega. Feito para ficar aberto num monitor. |
| **Despacho** (`/#/despacho`) | Fila de entregas, mapa com loja/zonas/pedidos/entregadores, criação e otimização de rotas, despacho automático, QR Code e Waze. |
| **App do entregador** (`/entregador`) | Rota do dia no celular, navegação por parada, confirmação de entrega, valores a receber e leitura do QR da comanda. |
| **Vitrine online** (`/loja`) | Cardápio público onde o cliente monta o pedido; ele cai direto na cozinha. |
| **Rastreio** (`/r/<token>`) | Página que o cliente acompanha em tempo real, com avaliação ao final. |
| **Caixa** (`/#/caixa`) | Abertura, conferência por forma de pagamento, comissão dos entregadores e fechamento com diferença. |
| **Relatórios** (`/#/relatorios`) | Faturamento por dia, ranking de produtos e clientes, exportação CSV. |
| **Cadastros** | Cardápio com adicionais e estoque, clientes com múltiplos endereços, entregadores com regra de comissão, zonas de entrega, usuários e permissões. |

Tudo em tempo real: o servidor publica eventos por SSE e as telas se atualizam
sozinhas — sem polling, sem F5.

---

## Roteirização, Waze e QR Code

O ponto central do sistema é levar o pedido da cozinha até a porta do cliente
com o menor percurso possível.

**Como a rota é montada.** A partir do endereço da loja, o servidor ordena as
paradas por vizinho mais próximo e refina com 2-opt (`server/lib/geo.js`),
estimando distância e tempo com a velocidade média e o tempo por parada
configurados. O despacho automático divide a fila entre os entregadores que
estão "na loja", agrupando por setor geográfico em torno da loja para que cada
um pegue uma região, não pedidos espalhados.

**Waze por parada.** O Waze navega para um destino por vez, então cada parada
carrega o seu link universal (`https://waze.com/ul?ll=…&navigate=yes`) — no app
do entregador e no painel de despacho. O trajeto completo, com todas as paradas,
abre no Google Maps.

**QR Code em três lugares:**

1. **QR da rota** — no painel e no romaneio impresso. O entregador aponta a
   câmera para a tela (ou para o papel) e a rota inteira abre no Maps do celular.
2. **QR da parada** — abre a navegação daquele endereço no Waze ou no Maps.
3. **QR do pedido** — impresso na comanda da cozinha. O entregador escaneia a
   comanda pelo app (`📷 Escanear pedido`) e o pedido entra na rota dele; se ele
   ainda não tiver rota, uma é criada na hora. É o caminho mais rápido para
   encaixar um pedido que saiu depois que a rota já foi montada.

A leitura usa a `BarcodeDetector` nativa do navegador (Chrome/Android). Onde a
API não existe, o mesmo modal aceita o código digitado — o fluxo nunca trava.

**Mesclar rotas.** Duas rotas pequenas do mesmo dia viram uma só, com o trajeto
reotimizado, quando um entregador assume a rota de um colega.

---

## Arquitetura

```
server/
  index.js          servidor HTTP, arquivos estáticos, SSE, bootstrap do admin
  api.js            composição das rotas
  schema.sql        esquema do banco
  db.js             conexão SQLite, migração, settings, transações reentrantes
  config.js         configuração + leitor de .env sem dependências
  seed.js           dados de demonstração
  lib/              http (router), auth (scrypt/sessões/RBAC), geo, money,
                    validate, events (SSE)
  routes/           auth, catalog, customers, orders, dispatch, reports, public
  services/         orders (máquina de estados), dispatch (rotas), pricing,
                    reports (caixa/indicadores), geocode, print (impressão térmica)
public/
  index.html        casca do painel (SPA)
  app/              api, store (estado + SSE), router, ui, navigation (Waze/QR),
                    views/ (uma por tela)
  loja.html         vitrine online     rastreio.html   acompanhamento do cliente
  entregador.html   app do entregador  vendor/         Leaflet e gerador de QR
legacy/
  painel-v1.html    painel antigo de arquivo único, preservado e funcional
tests/              75 testes (node:test)
```

**Decisões que valem explicar:**

- **Dinheiro em centavos.** Todo valor trafega e é gravado como inteiro; a
  formatação em reais acontece só na borda. Sem erro de ponto flutuante no caixa.
- **Preço congelado no pedido.** O item guarda nome e preço do momento da venda,
  então mexer no cardápio não reescreve o histórico nem o faturamento.
- **Máquina de estados explícita.** `recebido → em_preparo → pronto →
  em_entrega → entregue`, com cancelamento a partir de qualquer ponto aberto.
  Transições inválidas são recusadas no serviço, não só na tela — e um pedido de
  entrega própria não pula o entregador.
- **Dia comercial vira às 05h.** O pedido da meia-noite e meia pertence ao
  movimento da noite anterior, que é como o dono do restaurante conta o caixa.
- **Sem dependências de produção.** Menos superfície de ataque, `npm install`
  instantâneo e nada para atualizar por causa de CVE de terceiros.

---

## Perfis de acesso

| Perfil | Enxerga |
| --- | --- |
| **Administrador** | Tudo, incluindo usuários e configurações. |
| **Gerente** | Operação, cadastros, caixa e relatórios. |
| **Atendente** | Pedidos, clientes, despacho e caixa. Não edita cardápio nem usuários. |
| **Cozinha** | Só a fila de produção. |
| **Entregador** | Só o app de rotas, no celular. |

As permissões são verificadas no servidor a cada requisição
(`server/lib/auth.js`); a interface apenas reflete o que o perfil pode fazer.

---

## Configuração

Copie `.env.example` para `.env`:

| Variável | Para que serve |
| --- | --- |
| `PORT` | Porta HTTP (padrão 3000). |
| `OUTFOOD_DB` | Caminho do arquivo SQLite. |
| `OUTFOOD_SECRET` | Assina os cookies de sessão. **Troque em produção.** |
| `OUTFOOD_ADMIN_EMAIL` / `OUTFOOD_ADMIN_PASSWORD` | Administrador criado no primeiro boot. |
| `OUTFOOD_ORIGIN` | Libera CORS para um front hospedado em outro domínio. |

O resto (taxas, raio, tempos, impressora, PIX, horário) fica em **Configurações**,
dentro do sistema.

### Política de taxa de entrega

- **Por zona** — cada zona tem raio, cor e taxa; vale a de menor raio que contém
  o endereço.
- **Por km** — taxa base + valor por quilômetro em linha reta a partir da loja.
- **Fixa** — um valor para todo mundo.

Em qualquer uma delas, "frete grátis acima de X" e a taxa digitada à mão no PDV
têm prioridade.

---

## Impressão térmica

Comanda da cozinha, cupom do cliente, romaneio da rota e fechamento de caixa
saem formatados para 58 mm ou 80 mm, pela janela de impressão do navegador — sem
driver nem servidor de impressão. A comanda leva o QR do pedido e o romaneio
leva o QR da rota.

---

## Testes

```bash
npm test
```

75 testes cobrindo a otimização de rotas, o cálculo de preços e comissões, a
máquina de estados do pedido, o despacho (incluindo leitura de QR e mesclagem de
rotas) e a API HTTP de ponta a ponta — autenticação, permissões por perfil,
fluxo completo do pedido, proteção da vitrine online contra preço enviado pelo
cliente e travessia de diretório.

---

## Fora do escopo

Emissão fiscal (NFC-e/SAT), gateway de pagamento online e integração oficial com
as APIs de iFood/Rappi não estão implementados. Pedidos de plataforma são
lançados manualmente com canal e código próprios, e ficam de fora da roteirização
quando quem entrega é o parceiro.
