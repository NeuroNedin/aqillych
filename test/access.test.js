import { test } from "node:test";
import assert from "node:assert/strict";
import { createD1, captureTelegram } from "./helpers/d1.js";
import { migrate } from "../src/migrate.js";
import { handleUpdate } from "../src/bot.js";
import { getUser, listUsers, listInvites, listLeads } from "../src/db.js";

const OWNER = "100";
const STRANGER = "777";

async function setup() {
  const db = createD1();
  const env = {
    DB: db, BOT_TOKEN: "test", OWNER_ID: OWNER,
    TELEGRAM_API: "https://telegram.test/bot", APP_URL: "https://crm.example", TZ_OFFSET: "300",
  };
  await migrate(env);
  return { db, env };
}

let messageId = 0;
const say = (text, from) => ({
  update_id: ++messageId,
  message: { message_id: messageId, chat: { id: from }, from: { id: from, first_name: "Кто-то", username: "nick" }, text },
});

const lastText = (tg) => tg.of("sendMessage").pop()?.body.text ?? "";

test("посторонний без кода внутрь не попадает", async () => {
  const { db, env } = await setup();
  const tg = captureTelegram();
  try {
    await handleUpdate(env, say("/start", STRANGER));
    assert.match(lastText(tg), /по коду приглашения/);
    assert.equal(await getUser(db, STRANGER), null);

    await handleUpdate(env, say("Ахмад — @ahmad", STRANGER));
    assert.match(lastText(tg), /Не подошло/);
    assert.equal((await listLeads(db, STRANGER)).length, 0, "и ничего не записал");
  } finally {
    tg.restore();
  }
});

test("владелец заходит без кода и получает команды для себя", async () => {
  const { db, env } = await setup();
  const tg = captureTelegram();
  try {
    await handleUpdate(env, say("/start", OWNER));
    assert.match(lastText(tg), /\/invite/);
    assert.ok(await getUser(db, OWNER));
  } finally {
    tg.restore();
  }
});

test("код открывает доступ ровно одному человеку", async () => {
  const { db, env } = await setup();
  const tg = captureTelegram();
  try {
    await handleUpdate(env, say("/invite Брату", OWNER));
    const code = lastText(tg).match(/<code>([a-z0-9]{6})<\/code>/)[1];

    await handleUpdate(env, say(code, STRANGER));
    assert.match(lastText(tg), /доступ открыт/);
    const joined = await getUser(db, STRANGER);
    assert.equal(joined.invitedBy, code);

    // Тот же код второму человеку уже не подойдёт.
    await handleUpdate(env, say(code, "888"));
    assert.match(lastText(tg), /код уже использован/);
    assert.equal(await getUser(db, "888"), null);
  } finally {
    tg.restore();
  }
});

test("код на несколько человек тратится по одному разу", async () => {
  const { db, env } = await setup();
  const tg = captureTelegram();
  try {
    await handleUpdate(env, say("/invite 2 курс Шамси", OWNER));
    const code = lastText(tg).match(/<code>([a-z0-9]{6})<\/code>/)[1];

    await handleUpdate(env, say(code, "201"));
    await handleUpdate(env, say(code, "202"));
    await handleUpdate(env, say(code, "203"));

    assert.ok(await getUser(db, "201"));
    assert.ok(await getUser(db, "202"));
    assert.equal(await getUser(db, "203"), null);
    assert.match(lastText(tg), /код уже использован/);
  } finally {
    tg.restore();
  }
});

test("неверный код ничего не открывает", async () => {
  const { db, env } = await setup();
  const tg = captureTelegram();
  try {
    await handleUpdate(env, say("qqqqqq", STRANGER));
    assert.match(lastText(tg), /код не найден/);
    assert.equal(await getUser(db, STRANGER), null);
  } finally {
    tg.restore();
  }
});

test("базы не пересекаются", async () => {
  const { db, env } = await setup();
  const tg = captureTelegram();
  try {
    await handleUpdate(env, say("/invite", OWNER));
    const code = lastText(tg).match(/<code>([a-z0-9]{6})<\/code>/)[1];
    await handleUpdate(env, say(code, STRANGER));

    await handleUpdate(env, say("Ахмад — @ahmad_arabic — арабский", OWNER));
    await handleUpdate(env, say("Иса — @isa_coach — борьба", STRANGER));

    assert.deepEqual((await listLeads(db, OWNER)).map((l) => l.name), ["Ахмад"]);
    assert.deepEqual((await listLeads(db, STRANGER)).map((l) => l.name), ["Иса"]);
  } finally {
    tg.restore();
  }
});

test("один и тот же эксперт может быть в базах у двоих", async () => {
  const { db, env } = await setup();
  const tg = captureTelegram();
  try {
    await handleUpdate(env, say("/invite", OWNER));
    const code = lastText(tg).match(/<code>([a-z0-9]{6})<\/code>/)[1];
    await handleUpdate(env, say(code, STRANGER));

    await handleUpdate(env, say("Юсуф — @yusuf_finance", OWNER));
    await handleUpdate(env, say("Юсуф — @yusuf_finance", STRANGER));

    assert.equal((await listLeads(db, OWNER)).length, 1);
    assert.equal((await listLeads(db, STRANGER)).length, 1);
  } finally {
    tg.restore();
  }
});

test("команды владельца недоступны остальным", async () => {
  const { env } = await setup();
  const tg = captureTelegram();
  try {
    await handleUpdate(env, say("/invite", OWNER));
    const code = lastText(tg).match(/<code>([a-z0-9]{6})<\/code>/)[1];
    await handleUpdate(env, say(code, STRANGER));

    await handleUpdate(env, say("/invite", STRANGER));
    assert.match(lastText(tg), /только владелец/);
    await handleUpdate(env, say("/people", STRANGER));
    assert.match(lastText(tg), /команда владельца/);
  } finally {
    tg.restore();
  }
});

test("владелец видит, кто пользуется и какие коды свободны", async () => {
  const { env } = await setup();
  const tg = captureTelegram();
  try {
    await handleUpdate(env, say("/start", OWNER));
    await handleUpdate(env, say("/invite Брату", OWNER));
    const code = lastText(tg).match(/<code>([a-z0-9]{6})<\/code>/)[1];
    await handleUpdate(env, say(code, STRANGER));
    await handleUpdate(env, say("/invite 3 курсу", OWNER));

    await handleUpdate(env, say("/people", OWNER));
    const text = lastText(tg);
    assert.match(text, /Пользуются CRM — 2/);
    assert.match(text, /владелец/);
    assert.match(text, /курсу/);
    assert.doesNotMatch(text, new RegExp(code), "потраченный код в свободных не значится");
  } finally {
    tg.restore();
  }
});

test("владелец может отозвать невыданный код", async () => {
  const { db, env } = await setup();
  const tg = captureTelegram();
  try {
    await handleUpdate(env, say("/invite", OWNER));
    const code = lastText(tg).match(/<code>([a-z0-9]{6})<\/code>/)[1];

    await handleUpdate(env, say(`/revoke ${code}`, OWNER));
    assert.match(lastText(tg), /отозван/);
    assert.equal((await listInvites(db)).length, 0);

    await handleUpdate(env, say(code, STRANGER));
    assert.equal(await getUser(db, STRANGER), null);
  } finally {
    tg.restore();
  }
});

test("чужую карточку не отменить кнопкой из своего чата", async () => {
  const { db, env } = await setup();
  const tg = captureTelegram();
  try {
    await handleUpdate(env, say("/invite", OWNER));
    const code = lastText(tg).match(/<code>([a-z0-9]{6})<\/code>/)[1];
    await handleUpdate(env, say(code, STRANGER));

    await handleUpdate(env, say("Ахмад — @ahmad_arabic", OWNER));
    const token = tg.of("sendMessage").pop().body.reply_markup.inline_keyboard[0][0].callback_data.slice(5);

    await handleUpdate(env, {
      update_id: ++messageId,
      callback_query: { id: "cb", from: { id: STRANGER }, data: `undo:${token}`, message: { message_id: 1, chat: { id: STRANGER } } },
    });

    assert.equal((await listLeads(db, OWNER)).length, 1, "карточка владельца на месте");
  } finally {
    tg.restore();
  }
});
