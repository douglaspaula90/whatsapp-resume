import { Resend } from 'resend';
import { config } from './config';
import { getEmailThread, saveEmailThread } from './database';
import { GroupSummary } from './summarizer';

const resend = new Resend(config.email.resendApiKey);

function buildEmailHtml(summary: GroupSummary): string {
  const date = new Date().toLocaleDateString('pt-BR', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const periodFrom = summary.period.from
    ? new Date(summary.period.from).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : '--';
  const periodTo = summary.period.to
    ? new Date(summary.period.to).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : '--';

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: #075e54; color: white; padding: 16px 20px; border-radius: 8px 8px 0 0;">
        <h2 style="margin: 0; font-size: 18px;">Resumo: ${summary.groupName}</h2>
        <p style="margin: 4px 0 0; font-size: 13px; opacity: 0.85;">${date} &middot; ${summary.messageCount} mensagens &middot; ${periodFrom} - ${periodTo}</p>
      </div>
      <div style="background: #f0f0f0; padding: 20px; border-radius: 0 0 8px 8px;">
        ${summary.summary}
      </div>
      <p style="font-size: 11px; color: #999; text-align: center; margin-top: 16px;">
        Gerado automaticamente por whatsapp-resume
      </p>
    </div>
  `;
}

export async function sendGroupSummaryEmail(summary: GroupSummary): Promise<void> {
  if (summary.messageCount === 0) {
    console.log('[email] Skipping ' + summary.groupName + ' - no messages');
    return;
  }

  const thread = getEmailThread(summary.groupJid);
  const subject = 'Resumo WhatsApp: ' + summary.groupName;
  const html = buildEmailHtml(summary);

  const headers: Record<string, string> = {};

  // If there is an existing thread, reply to it to keep the email thread going
  if (thread?.message_id) {
    headers['In-Reply-To'] = thread.message_id;
    headers['References'] = thread.message_id;
  }

  const result = await resend.emails.send({
    from: config.email.from,
    to: [config.email.to],
    subject,
    html,
    headers,
  });

  if (result.data?.id) {
    // Resend returns its own ID; for threading we use the Message-ID format
    const messageId = '<' + result.data.id + '@resend.dev>';
    saveEmailThread(summary.groupJid, summary.groupName, messageId);
    console.log('[email] Sent summary for ' + summary.groupName + ' (id: ' + result.data.id + ')');
  }
}
