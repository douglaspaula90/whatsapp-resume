import cron from 'node-cron';
import { config } from './config';
import { getMessagesSince, getMonitoredGroups, getMonitoredGroupsWithNames, getGroupName, getAllUsers } from './database';
import { summarizeGroup } from './summarizer';
import { sendGroupSummaryEmail } from './email';

export interface GroupProgress {
  group_name: string;
  group_jid: string;
  status: 'processing' | 'done' | 'skipped' | 'error';
  message_count?: number;
  error?: string;
}

async function runSummaryForUser(
  userId: number,
  emailTo: string,
  onProgress?: (progress: GroupProgress) => void
): Promise<void> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const groups = getMonitoredGroupsWithNames(userId);

  if (groups.length === 0) return;

  for (const group of groups) {
    const groupName = group.group_name;
    const groupJid = group.group_jid;

    if (onProgress) onProgress({ group_name: groupName, group_jid: groupJid, status: 'processing' });

    try {
      const messages = getMessagesSince(userId, groupJid, since);
      console.log('[scheduler] User ' + userId + ' group "' + groupName + '": ' + messages.length + ' messages');

      if (messages.length === 0) {
        if (onProgress) onProgress({ group_name: groupName, group_jid: groupJid, status: 'skipped', message_count: 0 });
        continue;
      }

      const summary = await summarizeGroup(groupName, groupJid, messages);
      await sendGroupSummaryEmail(userId, emailTo, summary);

      if (onProgress) onProgress({ group_name: groupName, group_jid: groupJid, status: 'done', message_count: messages.length });
    } catch (err) {
      console.error('[scheduler] Error processing group ' + groupJid + ':', err);
      if (onProgress) onProgress({ group_name: groupName, group_jid: groupJid, status: 'error', error: String(err) });
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
