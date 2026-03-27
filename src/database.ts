import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from './config';

export interface Message {
  id?: number;
  user_id: number;
  group_jid: string;
  group_name: string;
  sender_jid: string;
  sender_name: string;
  content: string;
  message_type: string;
  timestamp: string;
  created_at?: string;
}

export interface User {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  instance_name: string;
  email_to: string;
  summary_cron: string;
  created_at: string;
}

let db: Database.Database;

function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

export function initDatabase(): void {
  const dir = path.dirname(config.dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      instance_name TEXT NOT NULL UNIQUE,
      email_to TEXT NOT NULL,
      summary_cron TEXT NOT NULL DEFAULT '0 23 * * *',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      group_jid TEXT NOT NULL,
      group_name TEXT NOT NULL,
      sender_jid TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      content TEXT NOT NULL,
      message_type TEXT NOT NULL DEFAULT 'text',
      timestamp TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_user_group_timestamp
      ON messages (user_id, group_jid, timestamp);

    CREATE TABLE IF NOT EXISTS group_email_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      group_jid TEXT NOT NULL,
      group_name TEXT NOT NULL,
      message_id TEXT,
      last_sent_at TEXT,
      UNIQUE(user_id, group_jid)
    );

    CREATE TABLE IF NOT EXISTS monitored_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      group_jid TEXT NOT NULL,
      group_name TEXT NOT NULL,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, group_jid)
    );

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// --- Users ---
export function createUser(name: string, email: string, password: string): User {
  const passwordHash = hashPassword(password);
  const instanceName = 'wr-' + crypto.randomBytes(6).toString('hex');
  const stmt = db.prepare(`
    INSERT INTO users (name, email, password_hash, instance_name, email_to)
    VALUES (@name, @email, @passwordHash, @instanceName, @email)
  `);
  stmt.run({ name, email: email.toLowerCase(), passwordHash, instanceName });
  return getUserByEmail(email.toLowerCase())!;
}

export function getUserByEmail(email: string): User | undefined {
  const stmt = db.prepare('SELECT * FROM users WHERE email = @email');
  return stmt.get({ email: email.toLowerCase() }) as User | undefined;
}

export function getUserById(id: number): User | undefined {
  const stmt = db.prepare('SELECT * FROM users WHERE id = @id');
  return stmt.get({ id }) as User | undefined;
}

export function verifyPassword(user: User, password: string): boolean {
  return user.password_hash === hashPassword(password);
}

export function updatePassword(userId: number, newPassword: string): void {
  const stmt = db.prepare('UPDATE users SET password_hash = @hash WHERE id = @userId');
  stmt.run({ hash: hashPassword(newPassword), userId });
}

export function updateUserSettings(userId: number, emailTo: string, summaryCron: string): void {
  const stmt = db.prepare('UPDATE users SET email_to = @emailTo, summary_cron = @summaryCron WHERE id = @userId');
  stmt.run({ emailTo, summaryCron, userId });
}

export function getAllUsers(): User[] {
  const stmt = db.prepare('SELECT * FROM users');
  return stmt.all() as User[];
}

// --- Password Reset ---
export function createResetToken(userId: number): string {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
  const stmt = db.prepare(`
    INSERT INTO password_reset_tokens (user_id, token, expires_at)
    VALUES (@userId, @token, @expiresAt)
  `);
  stmt.run({ userId, token, expiresAt });
  return token;
}

export function getResetToken(token: string): { user_id: number; expires_at: string; used: number } | undefined {
  const stmt = db.prepare('SELECT user_id, expires_at, used FROM password_reset_tokens WHERE token = @token');
  return stmt.get({ token }) as { user_id: number; expires_at: string; used: number } | undefined;
}

export function markResetTokenUsed(token: string): void {
  const stmt = db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE token = @token');
  stmt.run({ token });
}

// --- Messages ---
export function saveMessage(msg: Omit<Message, 'id' | 'created_at'>): void {
  const stmt = db.prepare(`
    INSERT INTO messages (user_id, group_jid, group_name, sender_jid, sender_name, content, message_type, timestamp)
    VALUES (@user_id, @group_jid, @group_name, @sender_jid, @sender_name, @content, @message_type, @timestamp)
  `);
  stmt.run(msg);
}

export function getMessagesSince(userId: number, groupJid: string, since: string): Message[] {
  const stmt = db.prepare(`
    SELECT * FROM messages
    WHERE user_id = @userId AND group_jid = @groupJid AND timestamp >= @since
    ORDER BY timestamp ASC
  `);
  return stmt.all({ userId, groupJid, since }) as Message[];
}

// --- Monitored Groups ---
export function getMonitoredGroups(userId: number): string[] {
  const stmt = db.prepare('SELECT group_jid FROM monitored_groups WHERE user_id = @userId');
  const rows = stmt.all({ userId }) as { group_jid: string }[];
  return rows.map(r => r.group_jid);
}

export function getMonitoredGroupsWithNames(userId: number): { group_jid: string; group_name: string }[] {
  const stmt = db.prepare('SELECT group_jid, group_name FROM monitored_groups WHERE user_id = @userId');
  return stmt.all({ userId }) as { group_jid: string; group_name: string }[];
}

export function addMonitoredGroup(userId: number, groupJid: string, groupName: string): void {
  const stmt = db.prepare(`
    INSERT INTO monitored_groups (user_id, group_jid, group_name)
    VALUES (@userId, @groupJid, @groupName)
    ON CONFLICT(user_id, group_jid) DO UPDATE SET group_name = @groupName
  `);
  stmt.run({ userId, groupJid, groupName });
}

export function removeMonitoredGroup(userId: number, groupJid: string): void {
  const stmt = db.prepare('DELETE FROM monitored_groups WHERE user_id = @userId AND group_jid = @groupJid');
  stmt.run({ userId, groupJid });
}

export function getGroupName(userId: number, groupJid: string): string {
  const stmt = db.prepare('SELECT group_name FROM monitored_groups WHERE user_id = @userId AND group_jid = @groupJid');
  const row = stmt.get({ userId, groupJid }) as { group_name: string } | undefined;
  return row?.group_name || groupJid;
}

// --- Email Threads ---
export function getEmailThread(userId: number, groupJid: string): { message_id: string | null; group_name: string } | undefined {
  const stmt = db.prepare('SELECT message_id, group_name FROM group_email_threads WHERE user_id = @userId AND group_jid = @groupJid');
  return stmt.get({ userId, groupJid }) as { message_id: string | null; group_name: string } | undefined;
}

export function saveEmailThread(userId: number, groupJid: string, groupName: string, messageId: string): void {
  const stmt = db.prepare(`
    INSERT INTO group_email_threads (user_id, group_jid, group_name, message_id, last_sent_at)
    VALUES (@userId, @groupJid, @groupName, @messageId, datetime('now'))
    ON CONFLICT(user_id, group_jid) DO UPDATE SET
      group_name = @groupName,
      message_id = @messageId,
      last_sent_at = datetime('now')
  `);
  stmt.run({ userId, groupJid, groupName, messageId });
}

// --- Instance lookup ---
export function getUserByInstanceName(instanceName: string): User | undefined {
  const stmt = db.prepare('SELECT * FROM users WHERE instance_name = @instanceName');
  return stmt.get({ instanceName }) as User | undefined;
}

export function closeDatabase(): void {
  if (db) db.close();
}
