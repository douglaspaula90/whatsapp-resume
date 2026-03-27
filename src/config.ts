import path from 'path';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error('Missing required environment variable: ' + name);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const config = {
  evolution: {
    apiUrl: required('EVOLUTION_API_URL'),
    apiKey: required('EVOLUTION_API_KEY'),
  },
  openai: {
    apiKey: required('OPENAI_API_KEY'),
  },
  email: {
    from: required('EMAIL_FROM'),
    resendApiKey: required('RESEND_API_KEY'),
  },
  appUrl: optional('APP_URL', ''),
  cookieSecret: optional('COOKIE_SECRET', 'whatsapp-resume-' + Date.now()),
  summaryCron: optional('SUMMARY_CRON', '0 23 * * *'),
  port: parseInt(optional('PORT', '3000'), 10),
  dbPath: path.resolve(optional('DB_PATH', './messages.db')),
};
