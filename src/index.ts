import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { initDatabase } from './database';
import { startScheduler } from './scheduler';
import webhookRouter from './webhook';
import adminRouter from './admin';

const app = express();
app.use(express.json());
app.use(cookieParser());

// Webhook endpoint for Evolution API
app.use(webhookRouter);

// Admin panel
app.use('/admin', adminRouter);

// Redirect root to admin
app.get('/', (_req, res) => {
  res.redirect('/admin');
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Initialize
initDatabase();
startScheduler();

app.listen(config.port, () => {
  console.log('[app] WhatsApp Resume running on port ' + config.port);
  console.log('[app] Admin panel: http://localhost:' + config.port + '/admin');
});
