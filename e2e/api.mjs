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
  check("подсказывает, что нужен код приглашения", /код приглашения/.test(r.data.error || ""), r.data.error);
}
{
  const res = await fetch(`${BASE}/api/state`, { headers: { "x-init-data": "user=%7B%22id%22%3A555%7D&hash=deadbeef&auth_date=1" } });
  const data = await res.json();
  check("поддельная подпись → 401", res.status === 401, res.status);
  check("причина названа человеческим языком", /BOT_TOKEN/.test(data.error || ""), data.error);
  check("машинная причина тоже отдана", data.reason === "bad_signature", data.reason);
}
{
  const old = await signInitData({
    user: JSON.stringify({ id: 555, first_name: "Али" }),
    auth_date: String(Math.floor(Date.now() / 1000) - 90000),
  }, TOKEN);
  const res = await fetch(`${BASE}/api/state`, { headers: { "x-init-data": old } });
  const data = await res.json();
  check("протухший вход объясняется отдельно", /старше суток/.test(data.error || ""), data.error);
}
{
  const res = await fetch(`${BASE}/tg/webhook`, { method: "POST", body: "{}" });
  check("вебхук без секрета → 403", res.status === 403, res.status);
}

console.log("\n— страница состояния чинит привязку —");
{
  // До этого момента бот ещё ни с чем не связан: открытие страницы
  // состояния должно само это исправить.
  const res = await fetch(`${BASE}/health`);
  const html = await res.text();
  check("открывается без входа", res.status === 200, res.status);
  const calls = JSON.parse(readFileSync(CALLS, "utf8"));
  const hook = calls.find((c) => c.method === "setWebhook");
  check("вебхук поставлен при открытии страницы", !!hook, calls.map((c) => c.method));
  check("вебхук ведёт на это приложение", hook?.payload.url === "http://localhost:8787/tg/webhook", hook?.payload.url);
  check("секрет вебхука выведен из токена",
    hook?.payload.secret_token === (await deriveWebhookSecret(TOKEN)), hook?.payload.secret_token);
  check("кнопка меню открывает приложение",
    calls.find((c) => c.method === "setChatMenuButton")?.payload.menu_button.web_app.url === "http://localhost:8787");
  check("команды бота заданы", !!calls.find((c) => c.method === "setMyCommands"));
  check("страница подтверждает привязку", /class="m y">✓<\/span><span><span class="t">Бот знаком с приложением/.test(html));
  check("говорит, что всё на месте", /<h1>Всё на месте<\/h1>/.test(html), html.match(/<h1>(.*?)<\/h1>/)?.[1]);
  check("показывает имя бота", /@test_crm_bot/.test(html));
  check("показывает постоянный адрес", /http:\/\/localhost:8787/.test(html));
  check("не печатает сам токен", !html.includes(TOKEN.split(":")[1]));
  check("не печатает OWNER_ID целиком", !/>555</.test(html) && /начинается на 555…/.test(html) === false || !html.includes(">555<"));
}

console.log("\n— привязка не повторяется —");
{
  // Страница состояния каждый раз спрашивает Telegram о боте — это её работа.
  // А вот заново настраивать вебхук, кнопку и команды она не должна.
  const WIRING = ["setWebhook", "setChatMenuButton", "setMyCommands"];
  const countWiring = () =>
    JSON.parse(readFileSync(CALLS, "utf8")).filter((c) => WIRING.includes(c.method)).length;

  const before = countWiring();
  await api("/api/state");
  await new Promise((r) => setTimeout(r, 500));
  await fetch(`${BASE}/health`);
  check("вход в мини-апп ничего не перенастраивает", countWiring() === before, [before, countWiring()]);
}

console.log("\n— состояние —");
const start = await api("/api/state");
check("state отдаёт 200", start.status === 200, start.data);
check("приходят словари", !!start.data.dict?.statuses?.length);
check("приходит серверное «сегодня»", /^\d{4}-\d{2}-\d{2}$/.test(start.data.today || ""), start.data.today);
const startCount = start.data.leads.length;

console.log("\n— настройки —");
{
  const before = await api("/api/state");
  check("настройки приходят с состоянием", !!before.data.settings, before.data);
  check("цели по умолчанию", before.data.settings.goals.cold === 30, before.data.settings);
  check("напоминание по умолчанию через 3 дня", before.data.settings.followDays === 3);

  const saved = await api("/api/settings", {
    goals: { partner: 5, cold: 50, call: 0, prepay: 2 },
    followDays: 7, digestHour: 8, tzOffset: 180,
  });
  check("сохранение отдаёт 200", saved.status === 200, saved.data);
  check("цели изменились", saved.data.settings.goals.cold === 50, saved.data.settings);
  check("строку можно скрыть нулём", saved.data.settings.goals.call === 0);
  check("часовой пояс применился к «сегодня»", /^\d{4}-\d{2}-\d{2}$/.test(saved.data.today), saved.data.today);

  const bad = await api("/api/settings", { goals: { cold: -5, partner: 9999 }, followDays: 999, digestHour: 99, tzOffset: 99999 });
  check("мусорные значения обрезаются, а не ломают", bad.status === 200, bad.data);
  check("отрицательная цель становится нулём", bad.data.settings.goals.cold === 0, bad.data.settings.goals);
  check("слишком большая цель обрезается", bad.data.settings.goals.partner === 999, bad.data.settings.goals);
  check("дни напоминания в разумных пределах", bad.data.settings.followDays === 60, bad.data.settings.followDays);
  check("час сводки в пределах суток", bad.data.settings.digestHour === 23, bad.data.settings.digestHour);

  // Возвращаем обычные значения, чтобы следующие проверки шли от них.
  const back = await api("/api/settings", { goals: { partner: 3, cold: 30, call: 2, prepay: 1 }, followDays: 3, digestHour: 9, tzOffset: 300 });
  check("настройки вернулись к обычным", back.data.settings.followDays === 3);
}

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
check("статус стал «написал»", ahmadAfter?.status === "wrote", ahmadAfter?.status);
check("дата касания = сегодня", ahmadAfter?.last === start.data.today, ahmadAfter?.last);
check("следующее касание через 3 дня", ahmadAfter?.next === wrote.data.next, [ahmadAfter?.next, wrote.data.next]);
check("сообщение попало в план недели", wrote.data.log.some((e) => e.kind === "msg" && e.plan === "cold"), wrote.data.log);

console.log("\n— карточка —");
const created = await api("/api/lead", { name: "Фотима", contact: "@fotima_smm", niche: "таргет", source: "warm", status: "interested" });
check("создание отдаёт 200", created.status === 200, created.data);
const fotima = created.data.leads.find((l) => l.name === "Фотима");
check("карточка сохранена", !!fotima && fotima.source === "warm" && fotima.status === "interested", fotima);

const dupe = await api("/api/lead", { name: "Фотима клон", contact: "t.me/fotima_smm" });
check("тот же контакт другой карточкой → 400", dupe.status === 400, dupe.status);
check("ошибка называет, кем занят контакт", /Фотима/.test(dupe.data.error || ""), dupe.data.error);

const toCall = await api("/api/lead", { id: fotima.id, name: "Фотима", contact: "@fotima_smm", status: "call", source: "warm" });
check("созвон засчитан в план", toCall.data.log.some((e) => e.kind === "call"), toCall.data.log);

const toInvoice = await api("/api/lead", { id: fotima.id, name: "Фотима", contact: "@fotima_smm", status: "invoice", source: "warm", next: "2030-01-01" });
check("счёт засчитан в план", toInvoice.data.log.some((e) => e.kind === "prepay"));
const invoiced = toInvoice.data.leads.find((l) => l.id === fotima.id);
check("выставленный счёт ещё надо дожимать — касание остаётся", invoiced?.next === "2030-01-01", invoiced?.next);

const toNo = await api("/api/lead", { id: fotima.id, name: "Фотима", contact: "@fotima_smm", status: "no", source: "warm", next: "2030-01-01" });
const closed = toNo.data.leads.find((l) => l.id === fotima.id);
check("у отказавшегося касание снято", closed?.next === "", closed?.next);

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
