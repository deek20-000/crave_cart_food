import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import authRoutes from './server/routes/auth.js';
import healthRoutes from './server/routes/health.js';
import restaurantRoutes from './server/routes/restaurants.js';
import cartRoutes from './server/routes/cart.js';
import orderRoutes from './server/routes/orders.js';
import profileRoutes from './server/routes/profile.js';
import adminRoutes from './server/routes/admin.js';
import deliveryRoutes from './server/routes/delivery.js';
import aiRoutes from './server/routes/ai.js';
import { checkDbConnection, query } from './server/db/pool.js';
import { runMigrationsAndSeeds } from './server/db/init.js';
import { seedExpandedDatabase } from './server/db/seed_expanded.js';
import { runChennaiAndFeaturesMigration } from './server/db/chennai_migration.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);
  const isProduction = process.env.NODE_ENV === 'production';

  app.use(express.json());

  // Mount API Endpoints
  app.use('/api/auth', authRoutes);
  app.use('/api/health', healthRoutes);
  app.use('/api/restaurants', restaurantRoutes);
  app.use('/api/cart', cartRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api/profile', profileRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/delivery', deliveryRoutes);
  app.use('/api/ai', aiRoutes);

  // Serve Vite in development or static dist in production
  if (!isProduction) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`[CraveCart] Server listening on http://0.0.0.0:${PORT}`);
    
    // Check Neon PostgreSQL connection on startup
    try {
      const dbStatus = await checkDbConnection();
      if (dbStatus.connected) {
        console.log(`[CraveCart] Connected to Neon PostgreSQL (database: ${dbStatus.database}, version: ${dbStatus.version})`);
        if (!dbStatus.tablesReady) {
          console.log('[CraveCart] Empty database detected, running initial schema setup...');
          const initRes = await runMigrationsAndSeeds();
          console.log(`[CraveCart] Schema initialization outcome: ${initRes.message}`);
        } else {
          console.log(`[CraveCart] Existing database tables and schema verified (${dbStatus.tablesCount} public tables). Preserving all production records.`);
        }
      } else {
        console.error(`[CraveCart] Neon database connection failed: ${dbStatus.error || 'DATABASE_URL not configured'}`);
      }
    } catch (err: any) {
      console.error('[CraveCart] Database startup check error:', err.message);
    }
  });
}

startServer().catch((err) => {
  console.error('[CraveCart Server Startup Fatal Error]:', err);
});
