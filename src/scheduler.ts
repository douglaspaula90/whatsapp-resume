import cron from 'node-cron';
import { config } from './config';
import { getMessagesSince, getMonitoredGroups, getGroupName, getAllUsers } from './database';
import { summarizeGroup } from './summarizer';
import { sendGroupSummaryEmail } from './email';

async function runSummaryForUser(userId: number, emailTo: string): Promise<void> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const groups = getMonitoredGroups(userId);

  if (groups.length === 0) return;

  for (const groupJid of groups) {
    try {
      const messages = getMessagesSince(userId, groupJid, since);
      const groupName = getGroupName(userId, groupJid);

      console.log('[scheduler] User ' + userId + ' group "' + groupName + '": ' + messages.length + ' messages');

      const summary = await summarizeGroup(groupName, groupJid, messages);
      await sendGroupSummaryEmail(userId, emailTo, summary);
    } catch (err) {
      console.error('[scheduler] Error processing group ' + groupJid + ' for user ' + userId + ':', err);
    }
  }
}

async function runDailySummary(): Promise<void> {
  console.log('[scheduler] Starting daily summary for all users...');
  const users = getAllUsers();

  for (const user of users) {
    try {
      console.log('[scheduler] Processing user: ' + user.email);
      await runSummaryForUser(user.id, user.email_to);
    } catch (err) {
      console.error('[scheduler] Error for user ' + user.email + ':', err);
    }
  }

  console.log('[scheduler] Daily summary complete.');
}

export function startScheduler(): void {
  const cronExpr = config.summaryCron;
  console.log('[scheduler] Global cron scheduled: ' + cronExpr);

  cron.schedule(cronExpr, () => {
    runDailySummary().catch(err => {
      console.error('[scheduler] Fatal error:', err);
    });
  });
}

export { runDailySummary, runSummaryForUser };
