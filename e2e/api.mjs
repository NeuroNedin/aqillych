// Проверка HTTP-API против локально запущенного Worker'а.
// Запускается из test/e2e/run.sh.

import { readFileSync } from "node:fs";
import { signInitData, deriveWebhookSecret } from "../src/auth.js";

const CALLS = process.argv[2]; // журнал заглушки Telegram

const BASE = "http://localhost:8787";
const TOKEN = "123456:AA-local-test-token";
let pass = 0, fail = 0;

function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`, extra ?? ""); }
}

const initData = (id = 555) => signInitData({
  user: JSON.stringify({ id, first_name: "Али" }),
  auth_date: String(Math.floor(Date.now() / 1000)),
}, TOKEN);

async function api(path, body, id = 555) {
  const headers = { "x-init-data": await initData(id) };
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(BASE + path, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

console.log("\n— доступ —");
{
  const res = await fetch(`${BASE}/api/state`);
  check("без initData → 401", res.status === 401, res.status);
}
{
  const r = await api("/api/state", null, 999);
  check("чужой telegram id → 403", r.status === 403, r.status);
}
{
  const res = await fetch(`${BASE}/api/state`, { headers: { "x-init-data": "user=%7B%22id%22%3A555%7D&hash=deadbeef&auth_date=1" } });
  check("поддельная подпись → 401", res.status === 401, res.status);
}
{
  const res = await fetch(`${BASE}/tg/webhook`, { method: "POST", body: "{}" });
  check("вебхук без секрета → 403", res.status === 403, res.status);
}

console.log("\n— приложение представляется Telegram —");
{
  // Первое же обращение мини-аппа должно настроить вебхук, кнопку и команды.
  await api("/api/state");
  let calls = [];
  for (let i = 0; i < 40; i++) {
    calls = JSON.parse(readFileSync(CALLS, "utf8"));
    if (calls.some((c) => c.method === "setMyCommands")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const hook = calls.find((c) => c.method === "setWebhook");
  check("вебхук поставлен сам", !!hook, calls.map((c) => c.method));
  check("вебхук ведёт на это приложение", hook?.payload.url === "http://localhost:8787/tg/webhook", hook?.payload.url);
  check("секрет вебхука выведен из токена",
    hook?.payload.secret_token === (await deriveWebhookSecret(TOKEN)), hook?.payload.secret_token);
  check("кнопка меню открывает приложение",
    calls.find((c) => c.method === "setChatMenuButton")?.payload.menu_button.web_app.url === "http://localhost:8787");
  check("команды бота заданы", !!calls.find((c) => c.method === "setMyCommands"));

  // Отметка в базе не даёт делать это заново на каждый запрос.
  const before = calls.length;
  await api("/api/state");
  await new Promise((r) => setTimeout(r, 400));
  check("повторный вход Telegram не беспокоит", JSON.parse(readFileSync(CALLS, "utf8")).length === before);
}

console.log("\n— состояние —");
const start = await api("/api/state");
check("state отдаёт 200", start.status === 200, start.data);
check("приходят словари", !!start.data.dict?.statuses?.length);
check("приходит серверное «сегодня»", /^\d{4}-\d{2}-\d{2}$/.test(start.data.today || ""), start.data.today);
const startCount = start.data.leads.length;

console.log("\n— добавление списком —");
const bulkText = [
  "Ахмад — @ahmad_arabic — преподаёт арабский",
  "Иса | t.me/isa_coach | тренер по борьбе",
  "@yusuf_finance",
  "Марьям — нутрициолог",
  "  ",
  "Ахмад дубль — https://t.me/AHMAD_ARABIC/",
].join("\n");
const bulk = await api("/api/bulk", { text: bulkText, source: "cold", niche: "эксперты" });
check("bulk отдаёт 200", bulk.status === 200, bulk.data);
check("добавлено 4", bulk.data.added === 4, bulk.data);
check("дубль внутри пачки отсеян", bulk.data.leads.length === startCount + 4, bulk.data.leads.length);

const ahmad = bulk.data.leads.find((l) => l.name === "Ахмад");
check("ниша из строки перебивает общую", ahmad?.niche === "преподаёт арабский", ahmad?.niche);
check("ссылка на телеграм построена", ahmad?.url === "https://t.me/ahmad_arabic", ahmad?.url);
const maryam = bulk.data.leads.find((l) => l.name === "Марьям");
check("человек без контакта тоже заведён", !!maryam && maryam.contact === "", maryam);
check("ниша из строки сохранена и без контакта", maryam?.niche === "нутрициолог", maryam?.niche);
const yusuf = bulk.data.leads.find((l) => l.name === "@yusuf_finance");
check("когда ниши в строке нет — берётся общая", yusuf?.niche === "эксперты", yusuf?.niche);
check("все попали в очередь", bulk.data.leads.every((l) => l.status === "new"));

console.log("\n— повторная пачка —");
const again = await api("/api/bulk", { text: "Ахмад ещё раз — @ahmad_arabic", source: "cold" });
check("уже известный контакт пропущен", again.data.added === 0 && again.data.skipped === 1, again.data);

console.log("\n— «Написал» —");
const wrote = await api("/api/wrote", { id: ahmad.id });
check("wrote отдаёт 200", wrote.status === 200, wrote.data);
const ahmadAfter = wrote.data.leads.find((l) => l.id === ahmad.id);
check("статус стал «написал»", ahmadAfter?.status === "sent", ahmadAfter?.status);
check("дата касания = сегодня", ahmadAfter?.last === start.data.today, ahmadAfter?.last);
check("следующее касание через 3 дня", ahmadAfter?.next === wrote.data.next, [ahmadAfter?.next, wrote.data.next]);
check("сообщение попало в план недели", wrote.data.log.some((e) => e.kind === "msg" && e.plan === "cold"), wrote.data.log);

console.log("\n— карточка —");
const created = await api("/api/lead", { name: "Фотима", contact: "@fotima_smm", niche: "таргет", source: "warm", status: "chat" });
check("создание отдаёт 200", created.status === 200, created.data);
const fotima = created.data.leads.find((l) => l.name === "Фотима");
check("карточка сохранена", !!fotima && fotima.source === "warm" && fotima.status === "chat", fotima);

const dupe = await api("/api/lead", { name: "Фотима клон", contact: "t.me/fotima_smm" });
check("тот же контакт другой карточкой → 400", dupe.status === 400, dupe.status);
check("ошибка называет, кем занят контакт", /Фотима/.test(dupe.data.error || ""), dupe.data.error);

const toCall = await api("/api/lead", { id: fotima.id, name: "Фотима", contact: "@fotima_smm", status: "call", source: "warm" });
check("созвон засчитан в план", toCall.data.log.some((e) => e.kind === "call"), toCall.data.log);

const toWork = await api("/api/lead", { id: fotima.id, name: "Фотима", contact: "@fotima_smm", status: "work", source: "warm", next: "2030-01-01" });
check("предоплата засчитана в план", toWork.data.log.some((e) => e.kind === "prepay"));
const closed = toWork.data.leads.find((l) => l.id === fotima.id);
check("у закрытой карточки снято касание", closed?.next === "", closed?.next);

const wroteClosed = await api("/api/wrote", { id: fotima.id });
check("по закрытой карточке «Написал» отклонён", wroteClosed.status === 400, wroteClosed.status);

console.log("\n— проверки ввода —");
check("пустое имя → 400", (await api("/api/lead", { name: "   " })).status === 400);
check("несуществующая карточка → 400", (await api("/api/lead", { id: "нет-такой", name: "X" })).status === 400);
check("пустой список → 400", (await api("/api/bulk", { text: "\n\n  " })).status === 400);
check("неизвестный маршрут → 404", (await api("/api/чего-то-нет", {})).status === 404);

const weird = await api("/api/lead", { name: "Тест", status: "нет-такого", source: "выдумка", next: "не дата" });
const weirdLead = weird.data.leads.find((l) => l.name === "Тест");
check("мусорный статус заменён на «новый»", weirdLead?.status === "new", weirdLead?.status);
check("мусорный источник заменён на «холодный»", weirdLead?.source === "cold", weirdLead?.source);
check("мусорная дата отброшена", weirdLead?.next === "", weirdLead?.next);

console.log("\n— удаление —");
const del = await api("/api/lead/delete", { id: weirdLead.id });
check("удаление отдаёт 200", del.status === 200);
check("карточки больше нет", !del.data.leads.some((l) => l.id === weirdLead.id));
check("повторное удаление → 404", (await api("/api/lead/delete", { id: weirdLead.id })).status === 404);

console.log(`\nИтого: ${pass} прошло, ${fail} упало\n`);
process.exit(fail ? 1 : 0);
