import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { initDatabase } from './database';
import { startScheduler, runDailySummary } from './scheduler';
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

// Manual trigger for testing
app.post('/trigger-summary', async (_req, res) => {
  try {
    await runDailySummary();
    res.json({ status: 'ok', message: 'Summary sent' });
  } catch (err) {
    console.error('[trigger] Error:', err);
    res.status(500).json({ status: 'error', message: String(err) });
  }
});

// Initialize
initDatabase();
startScheduler();

app.listen(config.port, () => {
  console.log('[app] WhatsApp Resume running on port ' + config.port);
  console.log('[app] Admin panel: http://localhost:' + config.port + '/admin');
  console.log('[app] Summary scheduled: ' + config.summaryCron);
});
