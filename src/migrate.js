// Приведение базы к текущей схеме. Выполняется при первом обращении
// и рассчитано на то, что в базе уже есть данные однопользовательской версии.

import {
  TABLES, INDEXES, UNIQUE_CONTACT_INDEX, LEGACY_CONTACT_INDEX,
  DEFAULT_GOALS, DEFAULT_FOLLOW_DAYS, DEFAULT_DIGEST_HOUR, DEFAULT_TZ_OFFSET,
} from "./schema.js";

async function columnNames(db, table) {
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set((results ?? []).map((r) => r.name));
}

async function indexNames(db) {
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all();
  return new Set((results ?? []).map((r) => r.name));
}

/**
 * @param {object} env — нужны DB и, для первого переноса, OWNER_ID
 */
export async function migrate(env) {
  const db = env.DB;
  await db.batch(TABLES.map((sql) => db.prepare(sql)));

  // База из однопользовательской версии не знает про владельцев.
  // Колонки добавляем до индексов: индекс по owner иначе не создать.
  for (const table of ["leads", "log"]) {
    const columns = await columnNames(db, table);
    if (!columns.has("owner")) {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN owner TEXT NOT NULL DEFAULT ''`).run();
    }
  }

  // Всё, что было заведено до разделения баз, принадлежит владельцу установки.
  const owner = String(env.OWNER_ID ?? "").trim();
  if (owner) {
    await db.batch([
      db.prepare("UPDATE leads SET owner = ? WHERE owner = ''").bind(owner),
      db.prepare("UPDATE log   SET owner = ? WHERE owner = ''").bind(owner),
    ]);
  }

  await db.batch(INDEXES.map((sql) => db.prepare(sql)));

  // Старый индекс запрещал двум владельцам вести одного и того же человека.
  const indexes = await indexNames(db);
  if (indexes.has(LEGACY_CONTACT_INDEX)) {
    await db.prepare(`DROP INDEX ${LEGACY_CONTACT_INDEX}`).run();
  }
  await db.prepare(UNIQUE_CONTACT_INDEX).run();

  if (owner) await ensureOwnerAccount(db, owner);
}

/** Владелец установки не вводит код приглашения — он уже внутри. */
async function ensureOwnerAccount(db, owner) {
  const row = await db.prepare("SELECT id FROM users WHERE id = ?").bind(owner).first();
  if (row) return;

  // Перенос настроек владельца из служебной таблицы, если он уже получал сводки.
  const lastDigest = await db.prepare("SELECT value FROM meta WHERE key = 'last_digest'").first();

  await db
    .prepare(
      `INSERT INTO users (id, name, username, joined, goals, follow_days, digest_hour, tz_offset, last_digest, invited_by)
       VALUES (?, '', '', ?, ?, ?, ?, ?, ?, 'owner')`,
    )
    .bind(
      owner,
      new Date().toISOString().slice(0, 10),
      JSON.stringify(DEFAULT_GOALS),
      DEFAULT_FOLLOW_DAYS,
      DEFAULT_DIGEST_HOUR,
      DEFAULT_TZ_OFFSET,
      lastDigest?.value ?? "",
    )
    .run();
}
