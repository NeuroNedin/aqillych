// Работа с D1. Вся валидация входных данных живёт здесь,
// чтобы ни мини-апп, ни бот не могли положить в базу мусор.

import { contactKey, contactUrl } from "./parse.js";
import { isStatus, isSource, isIsoDate, CLOSED, SOURCE_BY_KEY, FOLLOW_DAYS, addDays, mondayOf } from "./domain.js";

const LIMITS = { name: 200, contact: 300, niche: 200, hook: 2000, found: 2000, note: 2000 };

const clean = (v, max) => String(v ?? "").trim().slice(0, max);
const date = (v) => (isIsoDate(v) ? v : "");
const newId = () => crypto.randomUUID();

const COLUMNS = "id, name, contact, niche, source, status, hook, found, note, last, next, created, updated";

export async function listLeads(db) {
  const { results } = await db.prepare(`SELECT ${COLUMNS} FROM leads`).all();
  // url считаем здесь, чтобы мини-аппу не пришлось повторять разбор контактов.
  return (results ?? []).map((lead) => ({ ...lead, url: contactUrl(lead.contact) }));
}

// Журнал нужен только за текущую неделю — план считается по ней.
export async function listWeekLog(db, today) {
  const { results } = await db
    .prepare("SELECT date, kind, plan, lead FROM log WHERE date >= ?")
    .bind(mondayOf(today))
    .all();
  return results ?? [];
}

export async function getState(db, today) {
  const [leads, log] = await Promise.all([listLeads(db), listWeekLog(db, today)]);
  return { leads, log };
}

export async function getLead(db, id) {
  return db.prepare(`SELECT ${COLUMNS} FROM leads WHERE id = ?`).bind(id).first();
}

// Приводит присланную карточку к тому, что можно писать в базу.
function normalizeLead(input, { today, nowIso }) {
  const name = clean(input.name, LIMITS.name);
  if (!name) return { error: "Без имени карточку не сохранить" };

  const status = isStatus(input.status) ? input.status : "new";
  const source = isSource(input.source) ? input.source : "cold";
  const contact = clean(input.contact, LIMITS.contact);

  return {
    fields: {
      name,
      contact,
      contact_key: contactKey(contact),
      niche: clean(input.niche, LIMITS.niche),
      source,
      status,
      hook: clean(input.hook, LIMITS.hook),
      found: clean(input.found, LIMITS.found),
      note: clean(input.note, LIMITS.note),
      last: date(input.last),
      // Закрытым карточкам касание больше не нужно.
      next: CLOSED.has(status) ? "" : date(input.next),
      created: date(input.created) || today,
      updated: nowIso,
    },
  };
}

async function contactTakenBy(db, contactKeyValue, exceptId) {
  if (!contactKeyValue) return null;
  const row = await db
    .prepare("SELECT id, name FROM leads WHERE contact_key = ? AND id <> ? LIMIT 1")
    .bind(contactKeyValue, exceptId ?? "")
    .first();
  return row ?? null;
}

/**
 * Создаёт или обновляет карточку. Побочно пишет в журнал, когда
 * статус переходит в «созвон» или «в работе» — по ним считается план.
 */
export async function saveLead(db, id, input, { today, nowIso }) {
  const { fields, error } = normalizeLead(input, { today, nowIso });
  if (error) return { error };

  const taken = await contactTakenBy(db, fields.contact_key, id);
  if (taken) return { error: `Этот контакт уже заведён: ${taken.name}` };

  const previous = id ? await getLead(db, id) : null;
  if (id && !previous) return { error: "Карточка не найдена" };

  if (previous) {
    await db
      .prepare(
        `UPDATE leads SET name=?, contact=?, contact_key=?, niche=?, source=?, status=?,
         hook=?, found=?, note=?, last=?, next=?, updated=? WHERE id=?`,
      )
      .bind(
        fields.name, fields.contact, fields.contact_key, fields.niche, fields.source, fields.status,
        fields.hook, fields.found, fields.note, fields.last, fields.next, fields.updated, id,
      )
      .run();
  } else {
    id = newId();
    await db
      .prepare(
        `INSERT INTO leads (id, name, contact, contact_key, niche, source, status,
         hook, found, note, last, next, created, updated)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        id, fields.name, fields.contact, fields.contact_key, fields.niche, fields.source, fields.status,
        fields.hook, fields.found, fields.note, fields.last, fields.next, fields.created, fields.updated,
      )
      .run();
  }

  const before = previous?.status ?? null;
  if (fields.status !== before) {
    if (fields.status === "call") await addLog(db, { date: today, kind: "call", lead: id });
    if (fields.status === "work") await addLog(db, { date: today, kind: "prepay", lead: id });
  }

  return { id };
}

export async function deleteLead(db, id) {
  const res = await db.prepare("DELETE FROM leads WHERE id = ?").bind(id).run();
  if (!res.meta?.changes) return { error: "Карточка не найдена" };
  return { ok: true };
}

/**
 * «Написал»: отмечает сегодняшнее касание, назначает следующее
 * и засчитывает отправленное сообщение в план недели.
 */
export async function markWrote(db, id, { today }) {
  const lead = await getLead(db, id);
  if (!lead) return { error: "Карточка не найдена" };
  if (CLOSED.has(lead.status)) return { error: "Карточка уже закрыта" };

  const next = addDays(today, FOLLOW_DAYS);
  const status = !lead.status || lead.status === "new" ? "sent" : lead.status;

  await db
    .prepare("UPDATE leads SET last=?, next=?, status=?, updated=? WHERE id=?")
    .bind(today, next, status, new Date().toISOString(), id)
    .run();

  await addLog(db, { date: today, kind: "msg", plan: SOURCE_BY_KEY[lead.source]?.plan ?? "", lead: id });

  return { id, next };
}

/**
 * Заводит пачку людей. Уже известные контакты пропускаются —
 * и те, что есть в базе, и повторы внутри самой пачки.
 */
export async function bulkAdd(db, rows, { source, niche, today, nowIso }) {
  const src = isSource(source) ? source : "cold";
  const fallbackNiche = clean(niche, LIMITS.niche);

  const existing = await db.prepare("SELECT contact_key FROM leads WHERE contact_key <> ''").all();
  const known = new Set((existing.results ?? []).map((r) => r.contact_key));

  const statements = [];
  const inserted = [];
  let skipped = 0;

  for (const row of rows) {
    const name = clean(row.name, LIMITS.name);
    if (!name) { skipped++; continue; }

    const contact = clean(row.contact, LIMITS.contact);
    const key = contactKey(contact);
    if (key && known.has(key)) { skipped++; continue; }
    if (key) known.add(key);

    const id = newId();
    inserted.push({ id, name });
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO leads (id, name, contact, contact_key, niche, source, status,
           hook, found, note, last, next, created, updated)
           VALUES (?,?,?,?,?,?, 'new', '', '', '', '', '', ?, ?)`,
        )
        .bind(id, name, contact, key, clean(row.niche, LIMITS.niche) || fallbackNiche, src, today, nowIso),
    );
  }

  if (!statements.length) return { added: 0, skipped, created: [] };

  // OR IGNORE молча пропускает строку, если контакт успели завести
  // параллельно, поэтому сверяемся с тем, что база реально записала.
  const results = await db.batch(statements);
  const created = inserted.filter((_, i) => (results[i]?.meta?.changes ?? 1) > 0);
  skipped += inserted.length - created.length;

  return { added: created.length, skipped, created };
}

export async function addLog(db, entry) {
  await db
    .prepare("INSERT INTO log (id, date, kind, plan, lead) VALUES (?,?,?,?,?)")
    .bind(newId(), entry.date, entry.kind, entry.plan ?? "", entry.lead ?? "")
    .run();
}

export async function getMeta(db, key) {
  const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first();
  return row?.value ?? null;
}

export async function setMeta(db, key, value) {
  await db
    .prepare("INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, String(value))
    .run();
}
