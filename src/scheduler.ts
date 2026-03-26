import cron from 'node-cron';
import { config } from './config';
import { getMessagesSince, getMonitoredGroups, getGroupName } from './database';
import { summarizeGroup } from './summarizer';
import { sendGroupSummaryEmail } from './email';

async function runDailySummary(): Promise<void> {
  console.log('[scheduler] Starting daily summary...');

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const groups = getMonitoredGroups();

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
  console.log('[scheduler] Cron scheduled: ' + config.summaryCron);

  cron.schedule(config.summaryCron, () => {
    runDailySummary().catch(err => {
      console.error('[scheduler] Fatal error:', err);
    });
  });
}

// Export for manual trigger (useful for testing)
export { runDailySummary };
