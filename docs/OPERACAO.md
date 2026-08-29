# Como usar no dia a dia

Guia curto para quem vai operar o restaurante — não é documentação técnica.

## Antes de abrir

1. **Configurações** → nome, endereço da loja e **📍 Localizar**. Sem a
   coordenada da loja as rotas não são otimizadas.
2. **Zonas de entrega** → crie as zonas e arraste o pino de cada uma no mapa até
   o centro do bairro. A taxa da zona passa a valer sozinha nos pedidos.
3. **Cardápio** → categorias, produtos e adicionais. O tempo de preparo de cada
   produto alimenta a promessa de entrega ao cliente.
4. **Entregadores** → cadastre a equipe e a regra de comissão. Quem for usar o
   app precisa de um usuário com perfil "entregador" vinculado.
5. **Caixa** → abra o caixa com o fundo de troco.

## Durante o serviço

**Entrou pedido por telefone/WhatsApp** → *Novo pedido*. Digite o telefone: se o
cliente já comprou, nome e endereço voltam preenchidos. Clique nos produtos,
escolha a forma de pagamento e lance. Imprima a comanda.

**Cozinha** → deixe a tela *Cozinha* aberta num monitor. Ela se atualiza sozinha
e marca em vermelho o que passou da promessa. "Iniciar preparo" → "Marcar pronto".

**Saiu do forno** → tela *Despacho*. Selecione os pedidos e escolha o
entregador, ou clique em **⚡ Distribuir automático** para dividir a fila entre
quem está "na loja" — cada um pega uma região.

**Imprima o romaneio** (sai com o QR da rota) e mande o entregador iniciar.

**Pedido atrasado que saiu depois da rota montada** → o entregador escaneia o QR
da comanda pelo app (**📷 Escanear pedido**) e o pedido entra na rota dele. Sem
telefonema, sem digitar endereço.

**Entregador voltou e vai levar a rota de um colega** → botão **🔗 Mesclar** na
rota: as paradas pendentes migram e o trajeto é reotimizado.

## Para o entregador

Abre `/entregador` no celular e entra com o usuário dele.

- **Na loja / Em rota / Fora de turno** — o botão de status manda ele para a fila
  do despacho automático.
- Cada parada tem **Waze** (navegação direta), **Maps**, **QR** (para escanear
  de outro aparelho) e **Avisar** (WhatsApp pronto para o cliente).
- **✅ Entreguei** encerra a parada. **Não consegui** devolve o pedido para a
  loja com o motivo registrado.
- A tela mostra quanto ele tem a receber em dinheiro e o troco a levar.

## No fechamento

1. *Caixa* → **Fechar caixa**, digite o valor contado; o sistema mostra sobra ou
   falta na hora e guarda o registro.
2. *Entregadores* → tabela de acerto do dia: entregas, km, taxas, comissão e
   dinheiro que cada um tem em mãos.
3. *Relatórios* → **⬇ Exportar CSV** para levar ao contador.

## O que o cliente vê

O cupom sai com um QR e um link `/r/<código>`. Ele acompanha o preparo em tempo
real e avalia a entrega ao final. A nota aparece na ficha do pedido.

## Dicas

- O **dia comercial vira às 05h**: pedido de 01h da manhã entra no movimento da
  noite anterior, do jeito que o caixa é contado.
- Pedido de plataforma (iFood/Rappi) com entregador do parceiro: escolha
  *Entregador da plataforma* — ele fica fora do mapa e da roteirização, mas
  continua entrando no faturamento.
- Endereço sem coordenada aparece marcado no despacho: abra o pedido e clique em
  **📍 Localizar endereço** para ele entrar na otimização.
- Frete grátis, pedido mínimo e taxa por km ficam em *Configurações → Entrega e
  taxas*.
