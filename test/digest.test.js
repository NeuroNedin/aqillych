import { test } from "node:test";
import assert from "node:assert/strict";
import { maybeSendDigest } from "../src/index.js";

// Маленькая замена D1: понимает ровно те запросы, которые делает дайджест.
function fakeDb(leads = [], log = []) {
  const meta = new Map();
  const answer = (sql, args) => {
    if (sql.includes("FROM leads")) return { results: leads };
    if (sql.includes("FROM log")) return { results: log.filter((e) => e.date >= args[0]) };
    if (sql.includes("FROM meta")) return { row: meta.has(args[0]) ? { value: meta.get(args[0]) } : null };
    if (sql.includes("INTO meta")) { meta.set(args[0], args[1]); return { row: null }; }
    if (sql.startsWith("CREATE")) return { row: null };
    throw new Error(`Запрос не предусмотрен моком: ${sql}`);
  };
  return {
    meta,
    // Worker создаёт таблицы сам — мок просто соглашается.
    async batch(statements) {
      return statements.map(() => ({ meta: { changes: 0 } }));
    },
    prepare(sql) {
      let args = [];
      const api = {
        bind: (...a) => { args = a; return api; },
        all: async () => answer(sql, args),
        first: async () => answer(sql, args).row ?? null,
        run: async () => { answer(sql, args); return { meta: { changes: 1 } }; },
      };
      return api;
    },
  };
}

function envWith(db, extra = {}) {
  const sent = [];
  return {
    sent,
    env: {
      DB: db,
      BOT_TOKEN: "test",
      OWNER_ID: "555",
      TZ_OFFSET: "300",   // UTC+5
      DIGEST_HOUR: "9",
      APP_URL: "https://crm.example",
      // Вместо Telegram — запись в массив.
      TELEGRAM_API: "http://telegram.test/bot",
      ...extra,
    },
    install() {
      globalThis.fetch = async (url, options) => {
        sent.push({ url: String(url), body: JSON.parse(options.body) });
        return new Response(JSON.stringify({ ok: true, result: {} }), { headers: { "content-type": "application/json" } });
      };
    },
  };
}

// 04:00 UTC = 09:00 в UTC+5 — назначенный час.
const AT_NINE = new Date("2026-09-21T04:00:00Z");
const AT_TEN = new Date("2026-09-21T05:00:00Z");

const LEADS = [
  { id: "1", name: "Ахмад", contact: "@ahmad", niche: "арабский", source: "cold", status: "sent", next: "2026-09-18" },
  { id: "2", name: "Иса", contact: "@isa", niche: "борьба", source: "cold", status: "chat", next: "2026-09-21" },
  { id: "3", name: "Юсуф", contact: "@yusuf", niche: "", source: "warm", status: "new", next: "" },
  { id: "4", name: "Закрытый", contact: "@zak", niche: "", source: "cold", status: "no", next: "2026-09-01" },
];
const LOG = [{ date: "2026-09-21", kind: "msg", plan: "cold", lead: "1" }];

test("в неназначенный час дайджест не уходит", async () => {
  const h = envWith(fakeDb(LEADS, LOG));
  h.install();
  const res = await maybeSendDigest(h.env, AT_TEN);
  assert.equal(res.sent, false);
  assert.equal(h.sent.length, 0);
});

test("в назначенный час уходит один раз за день", async () => {
  const h = envWith(fakeDb(LEADS, LOG));
  h.install();

  assert.equal((await maybeSendDigest(h.env, AT_NINE)).sent, true);
  assert.equal(h.sent.length, 1);

  // Cron дёргает Worker снова в тот же час — второй раз слать нельзя.
  assert.equal((await maybeSendDigest(h.env, AT_NINE)).sent, false);
  assert.equal(h.sent.length, 1);

  // Следующий день — снова можно.
  assert.equal((await maybeSendDigest(h.env, new Date("2026-09-22T04:00:00Z"))).sent, true);
  assert.equal(h.sent.length, 2);
});

test("в дайджесте есть просрочки, сегодняшние, очередь и план", async () => {
  const h = envWith(fakeDb(LEADS, LOG));
  h.install();
  await maybeSendDigest(h.env, AT_NINE);

  const { body } = h.sent[0];
  assert.equal(body.chat_id, "555");
  assert.match(body.text, /Доброе утро\. Сегодня 21 сен\./);
  assert.match(body.text, /Просрочено — 1/);
  assert.match(body.text, /Ахмад/);
  assert.match(body.text, /с 18 сен/);
  assert.match(body.text, /Коснуться сегодня — 1/);
  assert.match(body.text, /Иса/);
  assert.match(body.text, /Ждут первого сообщения: <b>1<\/b>/);
  assert.match(body.text, /План недели: партнёры 0\/3 · холодные 1\/30/);
  // Карточка со статусом «не подходит» в напоминания не попадает.
  assert.doesNotMatch(body.text, /Закрытый/);
});

test("к дайджесту приложена кнопка в мини-апп", async () => {
  const h = envWith(fakeDb(LEADS, LOG));
  h.install();
  await maybeSendDigest(h.env, AT_NINE);
  const button = h.sent[0].body.reply_markup.inline_keyboard[0][0];
  assert.equal(button.web_app.url, "https://crm.example");
});

test("на пустой базе дайджест всё равно осмысленный", async () => {
  const h = envWith(fakeDb([], []));
  h.install();
  await maybeSendDigest(h.env, AT_NINE);
  assert.match(h.sent[0].body.text, /Касаний на сегодня нет/);
  assert.doesNotMatch(h.sent[0].body.text, /Ждут первого сообщения/);
});

test("час дайджеста берётся из настройки", async () => {
  const h = envWith(fakeDb(LEADS, LOG), { DIGEST_HOUR: "10" });
  h.install();
  assert.equal((await maybeSendDigest(h.env, AT_NINE)).sent, false);
  assert.equal((await maybeSendDigest(h.env, AT_TEN)).sent, true);
});
