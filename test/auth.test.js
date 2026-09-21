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
  assert.deepEqual(res, { ok: false, reason: "bad_signature" });
});

test("подменённое поле ломает подпись", async () => {
  const initData = await makeInitData();
  const params = new URLSearchParams(initData);
  params.set("user", JSON.stringify({ ...USER, id: 777 }));
  const res = await verifyInitData(params.toString(), TOKEN);
  assert.deepEqual(res, { ok: false, reason: "bad_signature" });
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
