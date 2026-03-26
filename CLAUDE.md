# whatsapp-resume

Daily WhatsApp group summarizer that collects messages via Evolution API webhooks,
summarizes them with Claude, and sends one email thread per group.

## Stack
- Node.js / TypeScript
- Evolution API (WhatsApp connection)
- SQLite via better-sqlite3 (message storage)
- Claude API via @anthropic-ai/sdk (summarization)
- Resend (email delivery)
- node-cron (scheduling)

## Build & Run
- `npm install` to install deps
- `npm run dev` to start dev server (tsx watch)
- `npm run build && npm start` for production
- Copy `.env.example` to `.env` and fill in your keys

## Conventions
- TypeScript strict mode
- Single quotes in code
- Commit messages in English, imperative mood
