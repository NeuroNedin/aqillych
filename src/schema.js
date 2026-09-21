// Структура базы. Worker создаёт её сам при первом обращении,
// поэтому разворачивать CRM можно вообще без командной строки.
export const SCHEMA = [
  // Карточки людей. Поля повторяют модель из прототипа «CRM Али».
  `CREATE TABLE IF NOT EXISTS leads (
    id          TEXT PRIMARY KEY,
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
  `CREATE INDEX IF NOT EXISTS idx_leads_status  ON leads(status)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_next    ON leads(next)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_updated ON leads(updated)`,
  // Один и тот же контакт не заводится дважды. Карточки без контакта
  // под ограничение не попадают.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_contact_key ON leads(contact_key) WHERE contact_key <> ''`,
  // Журнал действий: из него считается план недели.
  // kind: msg (отправил сообщение) | call (назначен созвон) | prepay (взял в работу)
  `CREATE TABLE IF NOT EXISTS log (
    id   TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    kind TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT '',
    lead TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_log_date ON log(date)`,
  // Служебные отметки: адрес мини-аппа, дата последнего дайджеста.
  `CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  )`,
];
