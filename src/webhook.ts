import { Router, Request, Response } from 'express';
import { saveMessage, getMonitoredGroups } from './database';

const router = Router();

interface EvolutionWebhookPayload {
  event: string;
  instance: string;
  data: {
    key: {
      remoteJid: string;
      fromMe: boolean;
      id: string;
      participant?: string;
    };
    pushName?: string;
    message?: {
      conversation?: string;
      extendedTextMessage?: { text?: string };
      imageMessage?: { caption?: string };
      videoMessage?: { caption?: string };
      documentMessage?: { caption?: string; fileName?: string };
    };
    messageTimestamp?: number | string;
    messageType?: string;
  };
}

function extractTextContent(message: EvolutionWebhookPayload['data']['message']): string | null {
  if (!message) return null;

  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return '[Imagem] ' + message.imageMessage.caption;
  if (message.videoMessage?.caption) return '[Vídeo] ' + message.videoMessage.caption;
  if (message.documentMessage) {
    const name = message.documentMessage.fileName || 'arquivo';
    const caption = message.documentMessage.caption || '';
    return '[Documento: ' + name + '] ' + caption;
  }

  return null;
}

router.post('/webhook/messages', (req: Request, res: Response) => {
  const payload = req.body as EvolutionWebhookPayload;

  if (payload.event !== 'messages.upsert') {
    res.sendStatus(200);
    return;
  }

  const { data } = payload;
  const remoteJid = data.key.remoteJid;

  // Only process group messages
  if (!remoteJid.endsWith('@g.us')) {
    res.sendStatus(200);
    return;
  }

  // Only process monitored groups
  const monitoredGroups = getMonitoredGroups();
  if (!monitoredGroups.includes(remoteJid)) {
    res.sendStatus(200);
    return;
  }

  // Skip own messages
  if (data.key.fromMe) {
    res.sendStatus(200);
    return;
  }

  const content = extractTextContent(data.message);
  if (!content) {
    res.sendStatus(200);
    return;
  }

  const timestamp = typeof data.messageTimestamp === 'number'
    ? new Date(data.messageTimestamp * 1000).toISOString()
    : new Date(parseInt(data.messageTimestamp || '0', 10) * 1000).toISOString();

  saveMessage({
    group_jid: remoteJid,
    group_name: remoteJid, // Will be updated by group metadata fetch
    sender_jid: data.key.participant || remoteJid,
    sender_name: data.pushName || 'Desconhecido',
    content,
    message_type: data.messageType || 'text',
    timestamp,
  });

  console.log('[webhook] Message saved from ' + (data.pushName || 'unknown') + ' in ' + remoteJid);
  res.sendStatus(200);
});

export default router;
