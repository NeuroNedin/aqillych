// Структура базы. Worker создаёт и обновляет её сам при первом обращении,
// поэтому разворачивать CRM можно без командной строки.

export const DEFAULT_GOALS = { partner: 3, cold: 30, call: 2, prepay: 1 };
export const DEFAULT_FOLLOW_DAYS = 3;
export const DEFAULT_DIGEST_HOUR = 9;
export const DEFAULT_TZ_OFFSET = 300; // UTC+5

export const TABLES = [
  // Карточки людей. owner — Telegram id того, чья это база.
  `CREATE TABLE IF NOT EXISTS leads (
    id          TEXT PRIMARY KEY,
    owner       TEXT NOT NULL DEFAULT '',
    name        TEXT NOT NULL DEFAULT '',
    contact     TEXT NOT NULL DEFAULT '',
    contact_key TEXT NOT NULL DEFAULT '',
    niche       TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT 'cold',
    status      TEXT NOT NULL DEFAULT 'new',
    hook        TEXT NOT NULL DEFAULT '',
    found       TEXT NOT NULL DEFAULT '',
    note        TEXT NOT NULL DEFAULT '',
    last        TEXT NOT NULL DEFAULT '',
    next        TEXT NOT NULL DEFAULT '',
    created     TEXT NOT NULL DEFAULT '',
    updated     TEXT NOT NULL DEFAULT ''
  )`,

  // Журнал действий: из него считается план недели.
  // kind: msg (отправил сообщение) | call (назначен созвон) | prepay (взял в работу)
  `CREATE TABLE IF NOT EXISTS log (
    id    TEXT PRIMARY KEY,
    owner TEXT NOT NULL DEFAULT '',
    date  TEXT NOT NULL,
    kind  TEXT NOT NULL,
    plan  TEXT NOT NULL DEFAULT '',
    lead  TEXT NOT NULL DEFAULT ''
  )`,

  // Люди, которым открыт доступ, и их личные настройки.
  `CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT '',
    username    TEXT NOT NULL DEFAULT '',
    joined      TEXT NOT NULL DEFAULT '',
    goals       TEXT NOT NULL DEFAULT '',
    follow_days INTEGER NOT NULL DEFAULT ${DEFAULT_FOLLOW_DAYS},
    digest_hour INTEGER NOT NULL DEFAULT ${DEFAULT_DIGEST_HOUR},
    tz_offset   INTEGER NOT NULL DEFAULT ${DEFAULT_TZ_OFFSET},
    last_digest TEXT NOT NULL DEFAULT '',
    invited_by  TEXT NOT NULL DEFAULT ''
  )`,

  // Коды приглашений: без кода бот никого не пускает.
  `CREATE TABLE IF NOT EXISTS invites (
    code     TEXT PRIMARY KEY,
    note     TEXT NOT NULL DEFAULT '',
    created  TEXT NOT NULL DEFAULT '',
    max_uses INTEGER NOT NULL DEFAULT 1,
    used     INTEGER NOT NULL DEFAULT 0
  )`,

  // Служебные отметки: адрес приложения, привязка бота.
  `CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  )`,
];

export const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_leads_owner    ON leads(owner)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_status   ON leads(status)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_next     ON leads(next)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_updated  ON leads(updated)`,
  `CREATE INDEX IF NOT EXISTS idx_log_owner_date ON log(owner, date)`,
];

/**
 * Один и тот же человек не заводится дважды в пределах ОДНОЙ базы,
 * но разные владельцы могут вести одного и того же эксперта.
 */
export const UNIQUE_CONTACT_INDEX =
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_owner_contact ON leads(owner, contact_key) WHERE contact_key <> ''`;

// Индекс из однопользовательской версии: мешает двум владельцам вести одного человека.
export const LEGACY_CONTACT_INDEX = "idx_leads_contact_key";
