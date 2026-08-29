import { Router } from './lib/http.js';
import { authRouter } from './routes/auth.js';
import { catalogRouter } from './routes/catalog.js';
import { customersRouter } from './routes/customers.js';
import { ordersRouter } from './routes/orders.js';
import { dispatchRouter } from './routes/dispatch.js';
import { reportsRouter } from './routes/reports.js';
import { publicRouter } from './routes/public.js';

/** Ordem importa: rotas mais específicas antes das que usam :id. */
export const api = new Router();
for (const router of [publicRouter, authRouter, catalogRouter, customersRouter, ordersRouter, dispatchRouter, reportsRouter]) {
  api.routes.push(...router.routes);
}
