import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyInitData, signInitData, deriveWebhookSecret } from "../src/auth.js";

const TOKEN = "123456:AA-test-token-not-real";
const USER = { id: 555, first_name: "Али", username: "ali" };

const makeInitData = (over = {}) =>
  signInitData(
    {
      query_id: "AAE",
      user: JSON.stringify(USER),
      auth_date: String(Math.floor(Date.now() / 1000)),
      ...over,
    },
    TOKEN,
  );

test("настоящая подпись проходит и отдаёт пользователя", async () => {
  const res = await verifyInitData(await makeInitData(), TOKEN);
  assert.equal(res.ok, true);
  assert.equal(res.user.id, 555);
});

test("подпись, снятая с другого бота, не проходит", async () => {
  const res = await verifyInitData(await makeInitData(), "999999:OTHER-token");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "bad_signature");
});

test("подменённое поле ломает подпись", async () => {
  const initData = await makeInitData();
  const params = new URLSearchParams(initData);
  params.set("user", JSON.stringify({ ...USER, id: 777 }));
  const res = await verifyInitData(params.toString(), TOKEN);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "bad_signature");
});

test("протухшие данные отклоняются", async () => {
  const old = String(Math.floor(Date.now() / 1000) - 90000);
  const res = await verifyInitData(await makeInitData({ auth_date: old }), TOKEN);
  assert.deepEqual(res, { ok: false, reason: "expired" });
});

test("свежие данные в пределах срока проходят", async () => {
  const recent = String(Math.floor(Date.now() / 1000) - 3600);
  const res = await verifyInitData(await makeInitData({ auth_date: recent }), TOKEN);
  assert.equal(res.ok, true);
});

test("дата из будущего отклоняется", async () => {
  const future = String(Math.floor(Date.now() / 1000) + 4000);
  const res = await verifyInitData(await makeInitData({ auth_date: future }), TOKEN);
  assert.deepEqual(res, { ok: false, reason: "future_auth_date" });
});

test("пустой и мусорный initData отклоняются без падения", async () => {
  assert.equal((await verifyInitData("", TOKEN)).ok, false);
  assert.equal((await verifyInitData(null, TOKEN)).ok, false);
  assert.equal((await verifyInitData("hash=deadbeef", TOKEN)).ok, false);
  assert.equal((await verifyInitData("user=%7B%7D&auth_date=1", TOKEN)).ok, false);
});

test("без user подпись бесполезна", async () => {
  const initData = await signInitData({ auth_date: String(Math.floor(Date.now() / 1000)) }, TOKEN);
  assert.deepEqual(await verifyInitData(initData, TOKEN), { ok: false, reason: "no_user" });
});

test("секрет вебхука выводится из токена и повторяем", async () => {
  const a = await deriveWebhookSecret(TOKEN);
  assert.equal(a, await deriveWebhookSecret(TOKEN));
  assert.notEqual(a, await deriveWebhookSecret("999999:OTHER-token"));
});

test("секрет вебхука годится для Telegram: 1-256 символов из A-Z a-z 0-9 _ -", async () => {
  assert.match(await deriveWebhookSecret(TOKEN), /^[A-Za-z0-9_-]{1,256}$/);
});

test("без токена секрета нет — вебхук останется закрытым", async () => {
  assert.equal(await deriveWebhookSecret(""), "");
  assert.equal(await deriveWebhookSecret(undefined), "");
});

test("секрет вебхука не совпадает с подписью initData", async () => {
  const secret = await deriveWebhookSecret(TOKEN);
  const initData = await makeInitData();
  assert.notEqual(secret, new URLSearchParams(initData).get("hash"));
});

test("данные с signature проходят, когда подпись считалась без него", async () => {
  const initData = await signInitData({
    query_id: "AAE",
    user: JSON.stringify(USER),
    auth_date: String(Math.floor(Date.now() / 1000)),
    signature: "aBcD-eFgH_1234",
  }, TOKEN);
  assert.match(initData, /signature=/);
  assert.equal((await verifyInitData(initData, TOKEN)).ok, true);
});

test("данные с signature проходят и когда клиент включил его в подпись", async () => {
  const fields = {
    query_id: "AAE",
    user: JSON.stringify(USER),
    auth_date: String(Math.floor(Date.now() / 1000)),
    signature: "aBcD-eFgH_1234",
  };
  const initData = await signInitData(fields, TOKEN, { signedFields: Object.keys(fields) });
  assert.equal((await verifyInitData(initData, TOKEN)).ok, true);
});

test("плюс в значении не ломает подпись", async () => {
  const initData = await signInitData({
    user: JSON.stringify({ ...USER, first_name: "Али+Недин" }),
    auth_date: String(Math.floor(Date.now() / 1000)),
  }, TOKEN);
  const res = await verifyInitData(initData, TOKEN);
  assert.equal(res.ok, true);
  assert.equal(res.user.first_name, "Али+Недин");
});

test("послабление к signature не открывает дверь чужому токену", async () => {
  const initData = await signInitData({
    user: JSON.stringify(USER),
    auth_date: String(Math.floor(Date.now() / 1000)),
    signature: "aBcD-eFgH_1234",
  }, TOKEN);
  const res = await verifyInitData(initData, "999999:OTHER");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "bad_signature");
});

test("подменённое поле не спасает ни один из вариантов подписи", async () => {
  const initData = await signInitData({
    user: JSON.stringify(USER),
    auth_date: String(Math.floor(Date.now() / 1000)),
    signature: "aBcD-eFgH_1234",
  }, TOKEN);
  const tampered = initData.replace(/user=[^&]*/, `user=${encodeURIComponent(JSON.stringify({ ...USER, id: 777 }))}`);
  const res = await verifyInitData(tampered, TOKEN);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "bad_signature");
});

test("значения в кириллице переживают разбор", async () => {
  const initData = await signInitData({
    user: JSON.stringify({ id: 555, first_name: "Али", last_name: "Недин" }),
    auth_date: String(Math.floor(Date.now() / 1000)),
  }, TOKEN);
  const res = await verifyInitData(initData, TOKEN);
  assert.equal(res.ok, true);
  assert.equal(res.user.last_name, "Недин");
});

test("при неверной подписи возвращаются имена полей — но не значения", async () => {
  const res = await verifyInitData(await makeInitData(), "999999:OTHER-token");
  assert.deepEqual(res.fields, ["auth_date", "hash", "query_id", "user"]);
  assert.equal(JSON.stringify(res).includes("Али"), false);
});
