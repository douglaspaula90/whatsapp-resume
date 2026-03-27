import cron from 'node-cron';
import { config } from './config';
import { getMessagesSince, getMonitoredGroups, getGroupName, getSetting } from './database';
import { summarizeGroup } from './summarizer';
import { sendGroupSummaryEmail } from './email';

async function runDailySummary(): Promise<void> {
  console.log('[scheduler] Starting daily summary...');

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const groups = getMonitoredGroups();

  if (groups.length === 0) {
    console.log('[scheduler] No monitored groups configured. Skipping.');
    return;
  }

  for (const groupJid of groups) {
    try {
      const messages = getMessagesSince(groupJid, since);
      const groupName = getGroupName(groupJid);

      console.log('[scheduler] Group "' + groupName + '": ' + messages.length + ' messages');

      const summary = await summarizeGroup(groupName, groupJid, messages);
      await sendGroupSummaryEmail(summary);
    } catch (err) {
      console.error('[scheduler] Error processing group ' + groupJid + ':', err);
    }
  }

  console.log('[scheduler] Daily summary complete.');
}

export function startScheduler(): void {
  const cronExpr = getSetting('summary_cron') || config.summaryCron;
  console.log('[scheduler] Cron scheduled: ' + cronExpr);

  cron.schedule(cronExpr, () => {
    runDailySummary().catch(err => {
      console.error('[scheduler] Fatal error:', err);
    });
  });
}

export { runDailySummary };
