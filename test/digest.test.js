import { test } from "node:test";
import assert from "node:assert/strict";
import { createD1, captureTelegram } from "./helpers/d1.js";
import { migrate } from "../src/migrate.js";
import { createUser, saveSettings, bulkAdd, saveLead } from "../src/db.js";
import { sendDueDigests } from "../src/index.js";

const OWNER = "100";

async function setup() {
  const db = createD1();
  const env = { DB: db, BOT_TOKEN: "test", OWNER_ID: OWNER, TELEGRAM_API: "https://telegram.test/bot", APP_URL: "https://crm.example" };
  await migrate(env);
  return { db, env };
}

const ctx = { today: "2026-09-21", nowIso: "2026-09-21T06:00:00Z" };

// 04:00 UTC = 09:00 в UTC+5.
const AT_NINE_TASHKENT = new Date("2026-09-21T04:00:00Z");

test("сводка уходит в назначенный час и только раз в день", async () => {
  const { db, env } = await setup();
  await saveLead(db, OWNER, null, { name: "Ахмад", contact: "@a", status: "sent", next: "2026-09-18" }, ctx);

  const tg = captureTelegram();
  try {
    assert.deepEqual((await sendDueDigests(env, AT_NINE_TASHKENT)).sent, [OWNER]);
    assert.equal(tg.of("sendMessage").length, 1);

    // Cron дёргает Worker каждый час — второй раз слать нельзя.
    assert.deepEqual((await sendDueDigests(env, AT_NINE_TASHKENT)).sent, []);
    assert.equal(tg.of("sendMessage").length, 1);

    // Следующий день — снова можно.
    assert.deepEqual((await sendDueDigests(env, new Date("2026-09-22T04:00:00Z"))).sent, [OWNER]);
  } finally {
    tg.restore();
  }
});

test("в неназначенный час никому ничего не уходит", async () => {
  const { env } = await setup();
  const tg = captureTelegram();
  try {
    assert.deepEqual((await sendDueDigests(env, new Date("2026-09-21T05:00:00Z"))).sent, []);
    assert.equal(tg.sent.length, 0);
  } finally {
    tg.restore();
  }
});

test("у каждого свой час и свой часовой пояс", async () => {
  const { db, env } = await setup();
  await createUser(db, { id: "200", name: "Иса", username: "isa", invitedBy: "abc123", today: "2026-09-20" });
  // Москва, сводка в 8 утра: 05:00 UTC.
  await saveSettings(db, "200", { goals: {}, followDays: 3, digestHour: 8, tzOffset: 180 });

  const tg = captureTelegram();
  try {
    assert.deepEqual((await sendDueDigests(env, AT_NINE_TASHKENT)).sent, [OWNER], "в 04:00 UTC — только владелец");
    assert.deepEqual((await sendDueDigests(env, new Date("2026-09-21T05:00:00Z"))).sent, ["200"], "в 05:00 UTC — второй");
  } finally {
    tg.restore();
  }
});

test("в сводке стоят цели этого человека, а не общие", async () => {
  const { db, env } = await setup();
  await saveSettings(db, OWNER, { goals: { partner: 5, cold: 50, call: 1, prepay: 2 }, followDays: 3, digestHour: 9, tzOffset: 300 });
  await bulkAdd(db, OWNER, [{ name: "Ахмад", contact: "@a", niche: "" }], { source: "cold", today: ctx.today, nowIso: ctx.nowIso });

  const tg = captureTelegram();
  try {
    await sendDueDigests(env, AT_NINE_TASHKENT);
    const text = tg.of("sendMessage")[0].body.text;
    assert.match(text, /партнёры 0\/5/);
    assert.match(text, /холодные 0\/50/);
    assert.match(text, /предоплаты 0\/2/);
  } finally {
    tg.restore();
  }
});

test("строки с целью 0 в сводку не попадают", async () => {
  const { db, env } = await setup();
  await saveSettings(db, OWNER, { goals: { partner: 0, cold: 30, call: 0, prepay: 1 }, followDays: 3, digestHour: 9, tzOffset: 300 });

  const tg = captureTelegram();
  try {
    await sendDueDigests(env, AT_NINE_TASHKENT);
    const text = tg.of("sendMessage")[0].body.text;
    assert.doesNotMatch(text, /партнёры/);
    assert.doesNotMatch(text, /созвоны/);
    assert.match(text, /холодные 0\/30/);
  } finally {
    tg.restore();
  }
});

test("сводка показывает просрочки и очередь, а закрытые карточки — нет", async () => {
  const { db, env } = await setup();
  await saveLead(db, OWNER, null, { name: "Ахмад", contact: "@a", status: "sent", next: "2026-09-18" }, ctx);
  await saveLead(db, OWNER, null, { name: "Иса", contact: "@i", status: "new" }, ctx);
  await saveLead(db, OWNER, null, { name: "Закрытый", contact: "@z", status: "no", next: "2026-09-01" }, ctx);

  const tg = captureTelegram();
  try {
    await sendDueDigests(env, AT_NINE_TASHKENT);
    const text = tg.of("sendMessage")[0].body.text;
    assert.match(text, /Доброе утро\. Сегодня 21 сен\./);
    assert.match(text, /Просрочено — 1/);
    assert.match(text, /Ахмад/);
    assert.match(text, /Ждут первого сообщения: <b>1<\/b>/);
    assert.doesNotMatch(text, /Закрытый/);
  } finally {
    tg.restore();
  }
});

test("каждому уходит только его база", async () => {
  const { db, env } = await setup();
  await createUser(db, { id: "200", name: "Иса", username: "isa", invitedBy: "abc123", today: "2026-09-20" });
  await saveLead(db, OWNER, null, { name: "МойКонтакт", contact: "@mine", status: "new" }, ctx);
  await saveLead(db, "200", null, { name: "ЕгоКонтакт", contact: "@his", status: "new" }, ctx);

  const tg = captureTelegram();
  try {
    await sendDueDigests(env, AT_NINE_TASHKENT);
    const mine = tg.of("sendMessage").find((c) => c.body.chat_id === OWNER);
    assert.match(mine.body.text, /Ждут первого сообщения: <b>1<\/b>/);
    assert.doesNotMatch(mine.body.text, /ЕгоКонтакт/);
  } finally {
    tg.restore();
  }
});
