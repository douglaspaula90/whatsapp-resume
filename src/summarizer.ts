import Anthropic from '@anthropic-ai/sdk';
import { config } from './config';
import { Message } from './database';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

export interface GroupSummary {
  groupJid: string;
  groupName: string;
  summary: string;
  messageCount: number;
  period: { from: string; to: string };
}

function formatMessagesForPrompt(messages: Message[]): string {
  return messages.map(m => {
    const time = new Date(m.timestamp).toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return '[' + time + '] ' + m.sender_name + ': ' + m.content;
  }).join('\n');
}

export async function summarizeGroup(groupName: string, groupJid: string, messages: Message[]): Promise<GroupSummary> {
  if (messages.length === 0) {
    return {
      groupJid,
      groupName,
      summary: 'Nenhuma mensagem nas últimas 24 horas.',
      messageCount: 0,
      period: { from: '', to: '' },
    };
  }

  const formattedMessages = formatMessagesForPrompt(messages);
  const firstTimestamp = messages[0].timestamp;
  const lastTimestamp = messages[messages.length - 1].timestamp;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6-20250514',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `Você é um assistente que resume conversas de grupos de WhatsApp.

Analise as mensagens abaixo do grupo "${groupName}" e crie um resumo estruturado.

REGRAS:
1. Agrupe as mensagens por TÓPICO/ASSUNTO discutido
2. Para cada tópico, liste:
   - Título curto do tópico
   - Resumo do que foi discutido (2-3 frases)
   - Participantes principais e o que cada um disse de relevante
   - Horários das mensagens-chave para referência
3. Se houver decisões tomadas, ações pendentes ou pedidos, destaque-os
4. Use português brasileiro
5. Formate em HTML para email (use <h3> para tópicos, <ul>/<li> para detalhes, <strong> para nomes)
6. Não inclua saudações genéricas (bom dia, etc.) no resumo, a menos que contenham informação relevante

MENSAGENS:
${formattedMessages}

Gere o resumo em HTML:`,
      },
    ],
  });

  const summaryText = response.content[0].type === 'text' ? response.content[0].text : '';

  return {
    groupJid,
    groupName,
    summary: summaryText,
    messageCount: messages.length,
    period: { from: firstTimestamp, to: lastTimestamp },
  };
}
