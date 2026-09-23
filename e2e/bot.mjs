// Проверка бота: вебхук дёргается по-настоящему, а Telegram подменён заглушкой.
// Запускается из test/e2e/run.sh.

import { readFileSync, writeFileSync } from "node:fs";
import { deriveWebhookSecret } from "../src/auth.js";

const BASE = "http://localhost:8787";
const SECRET = await deriveWebhookSecret("123456:AA-local-test-token");
const LOG = process.argv[2];
const OWNER = 555;
let pass = 0, fail = 0, msgId = 100;

const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`, JSON.stringify(extra ?? "")); }
};

const calls = () => JSON.parse(readFileSync(LOG, "utf8"));
const reset = () => writeFileSync(LOG, "[]");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(update) {
  reset();
  await fetch(`${BASE}/tg/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
    body: JSON.stringify(update),
  });
  // Обработка идёт в waitUntil — даём ей завершиться.
  for (let i = 0; i < 50 && calls().length === 0; i++) await sleep(100);
  await sleep(150);
  return calls();
}

const message = (text, from = OWNER) => ({
  update_id: ++msgId,
  message: { message_id: msgId, chat: { id: from }, from: { id: from }, text },
});

const lastText = (c) => c.filter((x) => x.method === "sendMessage").pop()?.payload.text ?? "";

console.log("\n— доступ —");
{
  const c = await send(message("Привет", 999));
  check("посторонний без кода не проходит", /код не найден/i.test(lastText(c)), lastText(c));
}
{
  const c = await send(message("/today", 999));
  check("и команды ему не отвечают", /приглашени/i.test(lastText(c)), lastText(c));
}

console.log("\n— приглашения —");
{
  const c = await send(message("/invite Брату"));
  const text = lastText(c);
  const code = text.match(/<code>([a-z0-9]{6})<\/code>/)?.[1];
  check("владелец получает код", !!code, text);

  const joined = await send(message(code, 4242));
  check("по коду открывается доступ", /доступ открыт/.test(lastText(joined)), lastText(joined));

  const reused = await send(message(code, 4343));
  check("код второй раз не работает", /уже использован/.test(lastText(reused)), lastText(reused));

  const own = await send(message("Свой контакт — @only_mine", 4242));
  check("новичок ведёт свою базу", /Добавил <b>1<\/b>/.test(lastText(own)), lastText(own));

  const mine = await send(message("/today"));
  check("в базе владельца чужого контакта нет", !/only_mine/.test(lastText(mine)), lastText(mine));
}

console.log("\n— команды —");
{
  const c = await send(message("/start"));
  check("/start отвечает", c.length === 1 && c[0].method === "sendMessage");
  check("/start объясняет формат", /по одному на строку/.test(lastText(c)) && /@ahmad_arabic/.test(lastText(c)), lastText(c));
  check("/start даёт кнопку в мини-апп", !!c[0].payload.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app);
}
{
  const c = await send(message("/nosuch"));
  check("неизвестная команда не заводит контакт", /Не знаю такой команды/.test(lastText(c)), lastText(c));
}

console.log("\n— список сообщением —");
let undoToken;
{
  const c = await send(message([
    "Ахмад — @ahmad_arabic — арабский",
    "Иса | t.me/isa_coach | борьба",
    "@yusuf_finance",
    "Марьям — нутрициолог",
  ].join("\n")));
  const text = lastText(c);
  check("бот подтвердил добавление", /Добавил <b>4<\/b>/.test(text), text);
  check("перечислил имена", /Ахмад/.test(text) && /Марьям/.test(text));
  const keyboard = c[0].payload.reply_markup?.inline_keyboard ?? [];
  undoToken = keyboard[0]?.[0]?.callback_data;
  check("предложил отменить", /^undo:/.test(undoToken || ""), undoToken);
}
{
  const c = await send(message("Ахмад снова — @ahmad_arabic"));
  check("повтор не создаёт дубль", /уже есть в базе/.test(lastText(c)), lastText(c));
}
{
  const c = await send(message("   \n  \n "));
  check("пустое сообщение — вежливый отказ", /Жду список/.test(lastText(c)), lastText(c));
}

console.log("\n— сводки —");
{
  const c = await send(message("/today"));
  const text = lastText(c);
  check("/today считает очередь", /Ждут первого сообщения: <b>4<\/b>/.test(text), text);
  check("/today показывает план недели", /План недели/.test(text), text);
}
{
  const c = await send(message("/plan"));
  check("/plan рисует прогресс", /Холодные 0\/30/.test(lastText(c)), lastText(c));
}

console.log("\n— отмена добавления —");
{
  const c = await send({
    update_id: ++msgId,
    callback_query: {
      id: "cb1", from: { id: OWNER }, data: undoToken,
      message: { message_id: 1, chat: { id: OWNER } },
    },
  });
  const answer = c.find((x) => x.method === "answerCallbackQuery");
  check("бот ответил на нажатие", answer?.payload.text === "Убрал 4", answer?.payload);
  check("сообщение переписано", c.some((x) => x.method === "editMessageText" && /Отменено/.test(x.payload.text)));
}
{
  const c = await send(message("/today"));
  check("после отмены база пуста", !/Ждут первого сообщения/.test(lastText(c)), lastText(c));
  check("и бот это говорит по-человечески", /Касаний на сегодня нет/.test(lastText(c)), lastText(c));
}
{
  const c = await send({
    update_id: ++msgId,
    callback_query: { id: "cb2", from: { id: OWNER }, data: undoToken, message: { message_id: 1, chat: { id: OWNER } } },
  });
  const answer = c.find((x) => x.method === "answerCallbackQuery");
  check("повторная отмена безопасна", answer?.payload.text === "Отменять уже нечего", answer?.payload);
}
{
  const c = await send({
    update_id: ++msgId,
    callback_query: { id: "cb3", from: { id: 999 }, data: undoToken, message: { message_id: 1, chat: { id: 999 } } },
  });
  check("чужое нажатие отклонено", c[0]?.payload.text === "Доступа нет", c[0]?.payload);
}

console.log("\n— экранирование —");
{
  const c = await send(message("<script>alert(1)</script> — @evil_user"));
  check("html из имени обезврежен", /&lt;script&gt;/.test(lastText(c)) && !/<script>/.test(lastText(c)), lastText(c));
}

console.log(`\nИтого: ${pass} прошло, ${fail} упало\n`);
process.exit(fail ? 1 : 0);
