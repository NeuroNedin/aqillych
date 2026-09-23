import { test } from "node:test";
import assert from "node:assert/strict";
import { createD1 } from "./helpers/d1.js";
import { migrate } from "../src/migrate.js";
import { listLeads, getUser, listUsers, saveLead } from "../src/db.js";

const OWNER = "284729103";

/** База в том виде, в каком она была до разделения по владельцам. */
function legacyDb() {
  const db = createD1();
  db.exec(`
    CREATE TABLE leads (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', contact TEXT NOT NULL DEFAULT '',
      contact_key TEXT NOT NULL DEFAULT '', niche TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'cold', status TEXT NOT NULL DEFAULT 'new',
      hook TEXT NOT NULL DEFAULT '', found TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
      last TEXT NOT NULL DEFAULT '', next TEXT NOT NULL DEFAULT '',
      created TEXT NOT NULL DEFAULT '', updated TEXT NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX idx_leads_contact_key ON leads(contact_key) WHERE contact_key <> '';
    CREATE TABLE log (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, kind TEXT NOT NULL,
      plan TEXT NOT NULL DEFAULT '', lead TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');

    INSERT INTO leads (id, name, contact, contact_key, niche, status, next, created, updated)
      VALUES ('l1', 'Ахмад', '@ahmad_arabic', 'tg:ahmad_arabic', 'арабский', 'sent', '2026-09-24', '2026-09-20', '2026-09-20T10:00:00Z');
    INSERT INTO leads (id, name, contact, contact_key, niche, status, created, updated)
      VALUES ('l2', 'Иса', 't.me/isa_coach', 'tg:isa_coach', 'борьба', 'new', '2026-09-20', '2026-09-20T10:00:00Z');
    INSERT INTO log (id, date, kind, plan, lead) VALUES ('g1', '2026-09-21', 'msg', 'cold', 'l1');
    INSERT INTO meta (key, value) VALUES ('last_digest', '2026-09-22');
    INSERT INTO meta (key, value) VALUES ('wired', 'https://aqillych.example.workers.dev');
  `);
  return db;
}

test("карточки из старой базы достаются владельцу", async () => {
  const db = legacyDb();
  await migrate({ DB: db, OWNER_ID: OWNER });

  const leads = await listLeads(db, OWNER);
  assert.deepEqual(leads.map((l) => l.name).sort(), ["Ахмад", "Иса"]);
  assert.equal((await listLeads(db, "999")).length, 0, "чужому ничего не видно");
});

test("журнал тоже переходит к владельцу — план недели не обнуляется", async () => {
  const db = legacyDb();
  await migrate({ DB: db, OWNER_ID: OWNER });

  const { results } = await db.prepare("SELECT owner, kind FROM log").all();
  assert.deepEqual(results, [{ owner: OWNER, kind: "msg" }]);
});

test("владелец заводится без кода приглашения, с настройками по умолчанию", async () => {
  const db = legacyDb();
  await migrate({ DB: db, OWNER_ID: OWNER });

  const me = await getUser(db, OWNER);
  assert.equal(me.invitedBy, "owner");
  assert.deepEqual(me.goals, { partner: 3, cold: 30, call: 2, prepay: 1 });
  assert.equal(me.followDays, 3);
  assert.equal(me.digestHour, 9);
  // Отметка о последней сводке переносится, чтобы она не пришла дважды.
  assert.equal(me.lastDigest, "2026-09-22");
});

test("двое могут вести одного и того же человека", async () => {
  const db = legacyDb();
  await migrate({ DB: db, OWNER_ID: OWNER });

  const ctx = { today: "2026-09-23", nowIso: "2026-09-23T08:00:00Z" };
  const mine = await saveLead(db, OWNER, null, { name: "Юсуф", contact: "@yusuf_finance" }, ctx);
  const theirs = await saveLead(db, "555000", null, { name: "Юсуф", contact: "@yusuf_finance" }, ctx);

  assert.ok(mine.id, mine.error);
  assert.ok(theirs.id, theirs.error);
});

test("в своей базе один контакт дважды не заводится", async () => {
  const db = legacyDb();
  await migrate({ DB: db, OWNER_ID: OWNER });

  const ctx = { today: "2026-09-23", nowIso: "2026-09-23T08:00:00Z" };
  const dupe = await saveLead(db, OWNER, null, { name: "Ахмад ещё раз", contact: "https://t.me/AHMAD_ARABIC/" }, ctx);
  assert.match(dupe.error ?? "", /уже заведён/);
});

test("повторная миграция ничего не портит", async () => {
  const db = legacyDb();
  await migrate({ DB: db, OWNER_ID: OWNER });
  await migrate({ DB: db, OWNER_ID: OWNER });
  await migrate({ DB: db, OWNER_ID: OWNER });

  assert.equal((await listLeads(db, OWNER)).length, 2);
  assert.equal((await listUsers(db)).length, 1);
});

test("миграция чистой базы даёт рабочую схему", async () => {
  const db = createD1();
  await migrate({ DB: db, OWNER_ID: OWNER });

  assert.equal((await listLeads(db, OWNER)).length, 0);
  assert.ok(await getUser(db, OWNER));
});

test("без OWNER_ID миграция не падает и никому ничего не приписывает", async () => {
  const db = legacyDb();
  await migrate({ DB: db });

  assert.equal((await listUsers(db)).length, 0);
  const { results } = await db.prepare("SELECT DISTINCT owner FROM leads").all();
  assert.deepEqual(results, [{ owner: "" }]);
});
