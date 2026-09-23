// Работа с D1. Вся валидация входных данных живёт здесь, чтобы ни
// мини-апп, ни бот не могли положить в базу мусор. Каждая карточка
// принадлежит владельцу: чужих контактов не видит никто.

import { contactKey, contactUrl } from "./parse.js";
import { isStatus, isSource, isIsoDate, CLOSED, SOURCE_BY_KEY, PLAN, addDays, mondayOf } from "./domain.js";
import {
  DEFAULT_GOALS, DEFAULT_FOLLOW_DAYS, DEFAULT_DIGEST_HOUR, DEFAULT_TZ_OFFSET,
} from "./schema.js";

const LIMITS = { name: 200, contact: 300, niche: 200, hook: 2000, found: 2000, note: 2000 };

const clean = (v, max) => String(v ?? "").trim().slice(0, max);
const date = (v) => (isIsoDate(v) ? v : "");
const newId = () => crypto.randomUUID();

const COLUMNS = "id, name, contact, niche, source, status, hook, found, note, last, next, created, updated";

/* ---------- карточки ---------- */

export async function listLeads(db, owner) {
  const { results } = await db.prepare(`SELECT ${COLUMNS} FROM leads WHERE owner = ?`).bind(owner).all();
  // url считаем здесь, чтобы мини-аппу не пришлось повторять разбор контактов.
  return (results ?? []).map((lead) => ({ ...lead, url: contactUrl(lead.contact) }));
}

// Журнал нужен только за текущую неделю — план считается по ней.
export async function listWeekLog(db, owner, today) {
  const { results } = await db
    .prepare("SELECT date, kind, plan, lead FROM log WHERE owner = ? AND date >= ?")
    .bind(owner, mondayOf(today))
    .all();
  return results ?? [];
}

export async function getState(db, owner, today) {
  const [leads, log] = await Promise.all([listLeads(db, owner), listWeekLog(db, owner, today)]);
  return { leads, log };
}

export async function getLead(db, owner, id) {
  return db.prepare(`SELECT ${COLUMNS} FROM leads WHERE owner = ? AND id = ?`).bind(owner, id).first();
}

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

async function contactTakenBy(db, owner, contactKeyValue, exceptId) {
  if (!contactKeyValue) return null;
  const row = await db
    .prepare("SELECT id, name FROM leads WHERE owner = ? AND contact_key = ? AND id <> ? LIMIT 1")
    .bind(owner, contactKeyValue, exceptId ?? "")
    .first();
  return row ?? null;
}

/**
 * Создаёт или обновляет карточку. Побочно пишет в журнал, когда статус
 * переходит в «созвон» или «в работе» — по ним считается план.
 */
export async function saveLead(db, owner, id, input, { today, nowIso }) {
  const { fields, error } = normalizeLead(input, { today, nowIso });
  if (error) return { error };

  const taken = await contactTakenBy(db, owner, fields.contact_key, id);
  if (taken) return { error: `Этот контакт уже заведён: ${taken.name}` };

  const previous = id ? await getLead(db, owner, id) : null;
  if (id && !previous) return { error: "Карточка не найдена" };

  if (previous) {
    await db
      .prepare(
        `UPDATE leads SET name=?, contact=?, contact_key=?, niche=?, source=?, status=?,
         hook=?, found=?, note=?, last=?, next=?, updated=? WHERE owner=? AND id=?`,
      )
      .bind(
        fields.name, fields.contact, fields.contact_key, fields.niche, fields.source, fields.status,
        fields.hook, fields.found, fields.note, fields.last, fields.next, fields.updated, owner, id,
      )
      .run();
  } else {
    id = newId();
    await db
      .prepare(
        `INSERT INTO leads (id, owner, name, contact, contact_key, niche, source, status,
         hook, found, note, last, next, created, updated)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        id, owner, fields.name, fields.contact, fields.contact_key, fields.niche, fields.source,
        fields.status, fields.hook, fields.found, fields.note, fields.last, fields.next,
        fields.created, fields.updated,
      )
      .run();
  }

  const before = previous?.status ?? null;
  if (fields.status !== before) {
    if (fields.status === "call") await addLog(db, owner, { date: today, kind: "call", lead: id });
    if (fields.status === "work") await addLog(db, owner, { date: today, kind: "prepay", lead: id });
  }

  return { id };
}

export async function deleteLead(db, owner, id) {
  const res = await db.prepare("DELETE FROM leads WHERE owner = ? AND id = ?").bind(owner, id).run();
  if (!res.meta?.changes) return { error: "Карточка не найдена" };
  return { ok: true };
}

/**
 * «Написал»: отмечает сегодняшнее касание, назначает следующее
 * и засчитывает отправленное сообщение в план недели.
 */
export async function markWrote(db, owner, id, { today, followDays = DEFAULT_FOLLOW_DAYS }) {
  const lead = await getLead(db, owner, id);
  if (!lead) return { error: "Карточка не найдена" };
  if (CLOSED.has(lead.status)) return { error: "Карточка уже закрыта" };

  const next = addDays(today, followDays);
  const status = !lead.status || lead.status === "new" ? "sent" : lead.status;

  await db
    .prepare("UPDATE leads SET last=?, next=?, status=?, updated=? WHERE owner=? AND id=?")
    .bind(today, next, status, new Date().toISOString(), owner, id)
    .run();

  await addLog(db, owner, { date: today, kind: "msg", plan: SOURCE_BY_KEY[lead.source]?.plan ?? "", lead: id });

  return { id, next };
}

/**
 * Заводит пачку людей. Уже известные контакты пропускаются —
 * и те, что есть в базе, и повторы внутри самой пачки.
 */
export async function bulkAdd(db, owner, rows, { source, niche, today, nowIso }) {
  const src = isSource(source) ? source : "cold";
  const fallbackNiche = clean(niche, LIMITS.niche);

  const existing = await db
    .prepare("SELECT contact_key FROM leads WHERE owner = ? AND contact_key <> ''")
    .bind(owner)
    .all();
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
          `INSERT OR IGNORE INTO leads (id, owner, name, contact, contact_key, niche, source, status,
           hook, found, note, last, next, created, updated)
           VALUES (?,?,?,?,?,?,?, 'new', '', '', '', '', '', ?, ?)`,
        )
        .bind(id, owner, name, contact, key, clean(row.niche, LIMITS.niche) || fallbackNiche, src, today, nowIso),
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

export async function addLog(db, owner, entry) {
  await db
    .prepare("INSERT INTO log (id, owner, date, kind, plan, lead) VALUES (?,?,?,?,?,?)")
    .bind(newId(), owner, entry.date, entry.kind, entry.plan ?? "", entry.lead ?? "")
    .run();
}

export async function deleteEverything(db, owner) {
  const res = await db.batch([
    db.prepare("DELETE FROM leads WHERE owner = ?").bind(owner),
    db.prepare("DELETE FROM log WHERE owner = ?").bind(owner),
  ]);
  return { leads: res[0]?.meta?.changes ?? 0 };
}

/* ---------- люди и их настройки ---------- */

const PLAN_KEYS = PLAN.map((p) => p.k);

/** Цели приводим к целым числам 0..999; 0 означает «не показывать строку». */
export function normalizeGoals(input) {
  const goals = {};
  for (const key of PLAN_KEYS) {
    const raw = Number(input?.[key]);
    goals[key] = Number.isFinite(raw) ? Math.min(999, Math.max(0, Math.round(raw))) : DEFAULT_GOALS[key];
  }
  return goals;
}

function readUser(row) {
  let goals;
  try {
    goals = normalizeGoals(JSON.parse(row.goals || "{}"));
  } catch {
    goals = { ...DEFAULT_GOALS };
  }
  return {
    id: String(row.id),
    name: row.name ?? "",
    username: row.username ?? "",
    joined: row.joined ?? "",
    goals,
    followDays: Number(row.follow_days) || DEFAULT_FOLLOW_DAYS,
    digestHour: Number.isFinite(Number(row.digest_hour)) ? Number(row.digest_hour) : DEFAULT_DIGEST_HOUR,
    tzOffset: Number.isFinite(Number(row.tz_offset)) ? Number(row.tz_offset) : DEFAULT_TZ_OFFSET,
    lastDigest: row.last_digest ?? "",
    invitedBy: row.invited_by ?? "",
  };
}

export async function getUser(db, id) {
  const row = await db.prepare("SELECT * FROM users WHERE id = ?").bind(String(id)).first();
  return row ? readUser(row) : null;
}

export async function listUsers(db) {
  const { results } = await db.prepare("SELECT * FROM users ORDER BY joined, id").all();
  return (results ?? []).map(readUser);
}

export async function createUser(db, { id, name, username, invitedBy, today }) {
  await db
    .prepare(
      `INSERT OR IGNORE INTO users (id, name, username, joined, goals, follow_days, digest_hour, tz_offset, invited_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      String(id), clean(name, 100), clean(username, 100), today,
      JSON.stringify(DEFAULT_GOALS), DEFAULT_FOLLOW_DAYS, DEFAULT_DIGEST_HOUR, DEFAULT_TZ_OFFSET,
      String(invitedBy ?? ""),
    )
    .run();
  return getUser(db, id);
}

/** Настройки, которые человек меняет сам в приложении. */
export async function saveSettings(db, id, input) {
  const goals = normalizeGoals(input.goals);
  const followDays = Math.min(60, Math.max(1, Math.round(Number(input.followDays)) || DEFAULT_FOLLOW_DAYS));
  const digestHour = Math.min(23, Math.max(0, Math.round(Number(input.digestHour)) || 0));
  const tzOffset = Math.min(840, Math.max(-720, Math.round(Number(input.tzOffset)) || 0));

  await db
    .prepare("UPDATE users SET goals = ?, follow_days = ?, digest_hour = ?, tz_offset = ? WHERE id = ?")
    .bind(JSON.stringify(goals), followDays, digestHour, tzOffset, String(id))
    .run();

  return getUser(db, id);
}

export async function markDigestSent(db, id, day) {
  await db.prepare("UPDATE users SET last_digest = ? WHERE id = ?").bind(day, String(id)).run();
}

export async function touchUserProfile(db, id, { name, username }) {
  await db
    .prepare("UPDATE users SET name = ?, username = ? WHERE id = ?")
    .bind(clean(name, 100), clean(username, 100), String(id))
    .run();
}

/* ---------- приглашения ---------- */

export async function createInvite(db, { code, note, maxUses, today }) {
  await db
    .prepare("INSERT INTO invites (code, note, created, max_uses, used) VALUES (?,?,?,?,0)")
    .bind(code, clean(note, 200), today, Math.max(1, Math.round(Number(maxUses)) || 1))
    .run();
  return { code };
}

export async function listInvites(db) {
  const { results } = await db.prepare("SELECT * FROM invites ORDER BY created DESC, code").all();
  return results ?? [];
}

/**
 * Проверяет код и отмечает использование. Счётчик увеличивается только
 * если лимит ещё не исчерпан — иначе кодом можно было бы поделиться.
 */
export async function redeemInvite(db, code) {
  const clean = String(code || "").trim().toLowerCase();
  if (!clean) return { ok: false, reason: "пустой код" };

  const res = await db
    .prepare("UPDATE invites SET used = used + 1 WHERE code = ? AND used < max_uses")
    .bind(clean)
    .run();
  if (res.meta?.changes) return { ok: true, code: clean };

  const row = await db.prepare("SELECT code FROM invites WHERE code = ?").bind(clean).first();
  return { ok: false, reason: row ? "код уже использован" : "код не найден" };
}

export async function deleteInvite(db, code) {
  const res = await db.prepare("DELETE FROM invites WHERE code = ?").bind(String(code).trim().toLowerCase()).run();
  return { deleted: res.meta?.changes ?? 0 };
}

/* ---------- служебное ---------- */

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
