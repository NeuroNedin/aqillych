-- Карточки людей. Поля повторяют модель из артефакта «CRM Али».
CREATE TABLE IF NOT EXISTS leads (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT '',
  contact     TEXT NOT NULL DEFAULT '',   -- как ввели: @ник, ссылка, телефон
  contact_key TEXT NOT NULL DEFAULT '',   -- нормализованный вид, по нему ловятся дубли
  niche       TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'cold',
  status      TEXT NOT NULL DEFAULT 'new',
  hook        TEXT NOT NULL DEFAULT '',   -- зацепка для первого сообщения
  found       TEXT NOT NULL DEFAULT '',   -- что выяснил: задача, боль, точка Б
  note        TEXT NOT NULL DEFAULT '',
  last        TEXT NOT NULL DEFAULT '',   -- YYYY-MM-DD последнего касания
  next        TEXT NOT NULL DEFAULT '',   -- YYYY-MM-DD следующего касания
  created     TEXT NOT NULL DEFAULT '',
  updated     TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_leads_status  ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_next    ON leads(next);
CREATE INDEX IF NOT EXISTS idx_leads_updated ON leads(updated);

-- Один и тот же контакт не заводится дважды: ни списком, ни через бота.
-- Карточки без контакта под ограничение не попадают.
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_contact_key
  ON leads(contact_key) WHERE contact_key <> '';

-- Журнал действий: из него считается план недели.
-- kind: msg (отправил сообщение) | call (назначен созвон) | prepay (взял в работу)
CREATE TABLE IF NOT EXISTS log (
  id   TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT '',   -- в какую графу плана падает: warm | partner | cold
  lead TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_log_date ON log(date);

-- Служебные отметки, чтобы утренний дайджест не ушёл дважды за день.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
