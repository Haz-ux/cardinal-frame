/**
 * Shared context for route modules.
 * 
 * The main server creates this object and passes it to each route module.
 * This avoids circular imports and keeps shared state in one place.
 * 
 * Usage in a route file:
 *   export default function authRoutes(ctx) {
 *     const { db, stmts, logger, authMiddleware } = ctx;
 *     const router = express.Router();
 *     router.post('/login', ...);
 *     return router;
 *   }
 */

// All shared state is set by server.mjs via `Object.assign(ctx, {...})`
export const ctx = {};
