// Проверка мини-аппа в настоящем браузере: Telegram SDK подменён,
// подпись initData — настоящая. Запускается из test/e2e/run.sh.

// PLAYWRIGHT_MODULE — путь к пакету, если он стоит глобально:
// NODE_PATH на import() в модулях не влияет.
let chromium;
try {
  ({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright"));
} catch {
  console.error("Для проверок в браузере нужен playwright: npm i -D playwright && npx playwright install chromium");
  console.error("Либо укажи уже установленный: PLAYWRIGHT_MODULE=/путь/playwright/index.mjs");
  process.exit(2);
}
import { signInitData } from "../src/auth.js";

const TOKEN = "123456:AA-local-test-token";
const BASE = "http://localhost:8787";
const OUT = process.argv[2];
let pass = 0, fail = 0;
const check = (n, c, e) => { c ? (pass++, console.log(`  ok  ${n}`)) : (fail++, console.log(`FAIL  ${n}`, e ?? "")); };

const initData = await signInitData({
  user: JSON.stringify({ id: 555, first_name: "Али" }),
  auth_date: String(Math.floor(Date.now() / 1000)),
}, TOKEN);

// Наполняем базу, как это сделал бы бот.
const api = (p, b) => fetch(BASE + p, {
  method: "POST", headers: { "content-type": "application/json", "x-init-data": initData }, body: JSON.stringify(b),
}).then((r) => r.json());

await api("/api/bulk", {
  text: [
    "Ахмад — @ahmad_arabic — преподаёт арабский",
    "Иса | t.me/isa_coach | тренер по борьбе",
    "@yusuf_finance",
    "Марьям — нутрициолог",
    "Фаррух — @farrukh_dev — разработка",
  ].join("\n"),
  source: "cold", niche: "эксперты",
});
await api("/api/bulk", { text: "Дильноза — @dilnoza_pr — пиар\nБобур — @bobur_biz", source: "warm" });
const state = await api("/api/lead", { name: "Санжар", contact: "@sanjar_coach", niche: "ораторка", source: "partner", status: "call", next: "2026-09-22" });
const ahmad = state.leads.find((l) => l.name === "Ахмад");
await api("/api/wrote", { id: ahmad.id });
await api("/api/lead", { id: ahmad.id, ...ahmad, status: "chat", next: "2020-01-01" });

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const page = await browser.newPage({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 2 });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

// Подменяем Telegram SDK до загрузки скриптов страницы.
await page.addInitScript(`window.Telegram = {
  WebApp: {
    initData: ${JSON.stringify(initData)},
    initDataUnsafe: { user: { id: 555, first_name: "Али" } },
    colorScheme: "light",
    ready(){}, expand(){}, disableVerticalSwipes(){}, onEvent(){},
    HapticFeedback: { notificationOccurred(){} },
    showConfirm(t, cb){ cb(true); },
  },
};`);

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector("#app:not([hidden])", { timeout: 10000 });

console.log("\n— вкладка «Кому написать» —");
check("приложение открылось", await page.isVisible("#app"));
check("экран ожидания скрыт", !(await page.isVisible("#gate")));
check("в заголовке имя владельца", (await page.textContent(".top h1")) === "CRM Али", await page.textContent(".top h1"));
check("на вкладке очереди нет лишней плавающей кнопки", !(await page.isVisible("#add")));
check("в очереди 6 человек", (await page.textContent("#queueCount")).includes("6"), await page.textContent("#queueCount"));
check("люди сгруппированы по источнику", (await page.locator(".group").count()) === 2, await page.locator(".group").count());
check("тёплый круг подписан", (await page.textContent("#queue")).includes("Тёплый круг"));
const isaCard = page.locator('#queue .card').filter({ has: page.locator('.name', { hasText: /^Иса$/ }) });
check("ссылка на телеграм кликабельна",
  (await isaCard.locator(".meta a").getAttribute("href")) === "https://t.me/isa_coach",
  await isaCard.locator(".meta").innerHTML());
await page.screenshot({ path: `${OUT}/queue.png`, fullPage: true });

console.log("\n— вкладка «В работе» —");
await page.click("#tab-work");
await page.waitForSelector("#view-work:not([hidden])");
check("план недели нарисован", (await page.locator("#plan .meter").count()) === 4);
check("на вкладке «В работе» плавающая кнопка есть", await page.isVisible("#add"));
check("отправленное сообщение засчитано", (await page.textContent("#plan")).includes("1 / 30"), await page.textContent("#plan"));
check("просроченный показан", (await page.textContent("#due")).includes("Ахмад"));
check("просрочка подсвечена", await page.isVisible("#due .when.late"));
check("у прошлогодней даты показан год", /с 1 янв 2020/.test(await page.textContent("#due")), await page.textContent("#due .when"));
check("в базе 8 карточек", (await page.textContent("#allCount")).includes("8"), await page.textContent("#allCount"));
await page.screenshot({ path: `${OUT}/work.png`, fullPage: true });

console.log("\n— поиск и фильтры —");
await page.fill("#q", "борьб");
await page.waitForTimeout(150);
check("поиск по нише находит", (await page.locator("#all .card").count()) === 1, await page.locator("#all .card").count());
await page.fill("#q", "");
await page.click('#chips .chip:has-text("Созвон назначен")');
await page.waitForTimeout(150);
check("фильтр по статусу работает", (await page.textContent("#all")).includes("Санжар"));
await page.click('#chips .chip:has-text("Все")');

console.log("\n— кнопка «Написал» —");
await page.click("#tab-queue");
await page.waitForSelector("#view-queue:not([hidden])");
const before = await page.locator("#queue .card").count();
const maryamCard = page.locator('#queue .card').filter({ has: page.locator('.name', { hasText: /^Марьям$/ }) });
await maryamCard.locator('[data-act="wrote"]').click();
await page.waitForFunction(`document.querySelectorAll("#queue .card").length === ${before - 1}`, null, { timeout: 5000 });
check("человек ушёл из очереди", (await page.locator("#queue .card").count()) === before - 1);
check("показано подтверждение", await page.isVisible(".toast"));

console.log("\n— карточка —");
const farrukhCard = page.locator('#queue .card').filter({ has: page.locator('.name', { hasText: /^Фаррух$/ }) });
await farrukhCard.locator('[data-act="open"]').click();
await page.waitForSelector("#dlg[open]");
check("карточка открылась с данными", (await page.inputValue("#f-name")) === "Фаррух");
check("контакт подставлен", (await page.inputValue("#f-contact")) === "@farrukh_dev");
await page.fill("#f-hook", "Понравился его рилс про найм");
await page.fill("#f-niche", "разработка и найм");
await page.click("#save");
await page.waitForSelector("#dlg", { state: "hidden", timeout: 5000 });
await page.waitForTimeout(400);
check("зацепка сохранилась и видна в очереди", (await page.textContent("#queue")).includes("Понравился его рилс"));
await page.screenshot({ path: `${OUT}/queue-hook.png`, fullPage: true });

console.log("\n— добавление списком из приложения —");
await page.click("#bulk");
await page.waitForSelector("#bulkDlg[open]");
await page.fill("#b-text", "Нодира — @nodira_edu — обучение\nТимур | @timur_fit | фитнес\nАхмад дубль — @ahmad_arabic");
await page.waitForTimeout(100);
check("превью считает строки", (await page.textContent("#bulkPreview")).includes("3"), await page.textContent("#bulkPreview"));
await page.click("#bulkSave");
await page.waitForSelector("#bulkDlg", { state: "hidden", timeout: 5000 });
await page.waitForTimeout(400);
check("добавлены новые, дубль отсеян", (await page.textContent(".toast")).includes("Добавлено: 2") && (await page.textContent(".toast")).includes("уже были в базе: 1"), await page.textContent(".toast"));

console.log("\n— настройки —");
await page.click("#tab-work");
await page.waitForSelector("#view-work:not([hidden])");
await page.click("#openSettings");
await page.waitForSelector("#setDlg[open]");
check("цели подставлены из базы", (await page.inputValue('[data-goal="cold"]')) === "30");
check("все четыре строки плана видны", (await page.locator("#goals .goal").count()) === 4);

await page.fill('[data-goal="cold"]', "50");
await page.fill('[data-goal="partner"]', "0");
await page.fill("#s-follow", "5");
await page.selectOption("#s-hour", "7");
await page.click("#setSave");
await page.waitForSelector("#setDlg", { state: "hidden", timeout: 5000 });
await page.waitForTimeout(400);

check("новая цель показана в плане", (await page.textContent("#plan")).includes("/ 50"), await page.textContent("#plan"));
check("строка с нулём скрыта", !(await page.textContent("#plan")).includes("Партнёры"), await page.textContent("#plan"));
check("осталось три строки", (await page.locator("#plan .meter").count()) === 3);

await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector("#app:not([hidden])");
await page.click("#tab-work");
await page.waitForSelector("#view-work:not([hidden])");
check("настройки пережили перезагрузку", (await page.textContent("#plan")).includes("/ 50"));

await page.click("#openSettings");
await page.waitForSelector("#setDlg[open]");
check("дни напоминания сохранились", (await page.inputValue("#s-follow")) === "5");
check("час сводки сохранился", (await page.inputValue("#s-hour")) === "7");
await page.click("#tzAuto");
check("часовой пояс берётся с устройства",
  (await page.inputValue("#s-tz")) === String(-new Date().getTimezoneOffset()), await page.inputValue("#s-tz"));
await page.click("#setCancel");
await page.waitForSelector("#setDlg", { state: "hidden" });
await page.screenshot({ path: `${OUT}/settings.png`, fullPage: true });

console.log("\n— тёмная тема —");
await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/dark.png`, fullPage: true });
check("фон переключился на тёмный",
  (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === "rgb(14, 19, 17)");

console.log("\n— без Telegram —");
const plain = await browser.newPage({ viewport: { width: 400, height: 860 } });
await plain.goto(BASE, { waitUntil: "networkidle" });
await plain.waitForSelector("#gate:not([hidden])");
check("вне Telegram показан внятный экран", (await plain.textContent("#gateTitle")).includes("Открой через Telegram"));
check("данные не показаны", !(await plain.isVisible("#app")));

// Внешние CDN в этой песочнице закрыты — такие ошибки к коду не относятся.
const own = errors.filter((e) => !/telegram\.org|fonts\.g|ERR_TUNNEL|ERR_CERT|Failed to load resource/.test(e));
check("в консоли нет своих ошибок", own.length === 0, own.slice(0, 3));

await browser.close();
console.log(`\nИтого: ${pass} прошло, ${fail} упало\n`);
process.exit(fail ? 1 : 0);
