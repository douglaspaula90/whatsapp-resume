import 'dotenv/config';
import express from 'express';
import { config } from './config';
import { initDatabase } from './database';
import { startScheduler, runDailySummary } from './scheduler';
import webhookRouter from './webhook';

const app = express();
app.use(express.json());

// Webhook endpoint for Evolution API
app.use(webhookRouter);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', groups: config.whatsappGroups.length });
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
  console.log('[app] Monitoring ' + config.whatsappGroups.length + ' group(s)');
  console.log('[app] Summary scheduled: ' + config.summaryCron);
});
