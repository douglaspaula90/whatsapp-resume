import Database from 'better-sqlite3';
import { config } from './config';

export interface Message {
  id?: number;
  group_jid: string;
  group_name: string;
  sender_jid: string;
  sender_name: string;
  content: string;
  message_type: string;
  timestamp: string;
  created_at?: string;
}

let db: Database.Database;

export function initDatabase(): void {
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_jid TEXT NOT NULL,
      group_name TEXT NOT NULL,
      sender_jid TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      content TEXT NOT NULL,
      message_type TEXT NOT NULL DEFAULT 'text',
      timestamp TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_group_timestamp
      ON messages (group_jid, timestamp);

    CREATE TABLE IF NOT EXISTS group_email_threads (
      group_jid TEXT PRIMARY KEY,
      group_name TEXT NOT NULL,
      message_id TEXT,
      last_sent_at TEXT
    );
  `);
}

export function saveMessage(msg: Omit<Message, 'id' | 'created_at'>): void {
  const stmt = db.prepare(`
    INSERT INTO messages (group_jid, group_name, sender_jid, sender_name, content, message_type, timestamp)
    VALUES (@group_jid, @group_name, @sender_jid, @sender_name, @content, @message_type, @timestamp)
  `);
  stmt.run(msg);
}

export function getMessagesSince(groupJid: string, since: string): Message[] {
  const stmt = db.prepare(`
    SELECT * FROM messages
    WHERE group_jid = @groupJid AND timestamp >= @since
    ORDER BY timestamp ASC
  `);
  return stmt.all({ groupJid, since }) as Message[];
}

export function getMonitoredGroups(): string[] {
  return config.whatsappGroups;
}

export function getGroupName(groupJid: string): string {
  const stmt = db.prepare(`
    SELECT group_name FROM messages
    WHERE group_jid = @groupJid
    ORDER BY id DESC LIMIT 1
  `);
  const row = stmt.get({ groupJid }) as { group_name: string } | undefined;
  return row?.group_name || groupJid;
}

export function getEmailThread(groupJid: string): { message_id: string | null; group_name: string } | undefined {
  const stmt = db.prepare(`
    SELECT message_id, group_name FROM group_email_threads
    WHERE group_jid = @groupJid
  `);
  return stmt.get({ groupJid }) as { message_id: string | null; group_name: string } | undefined;
}

export function saveEmailThread(groupJid: string, groupName: string, messageId: string): void {
  const stmt = db.prepare(`
    INSERT INTO group_email_threads (group_jid, group_name, message_id, last_sent_at)
    VALUES (@groupJid, @groupName, @messageId, datetime('now'))
    ON CONFLICT(group_jid) DO UPDATE SET
      group_name = @groupName,
      message_id = @messageId,
      last_sent_at = datetime('now')
  `);
  stmt.run({ groupJid, groupName, messageId });
}

export function closeDatabase(): void {
  if (db) db.close();
}
