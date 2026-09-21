#!/usr/bin/env node
/**
 * Привязывает бота к задеплоенному Worker'у: вебхук, команды и кнопка меню.
 * Запускать после каждого изменения адреса Worker'а.
 *
 *   BOT_TOKEN=... WEBHOOK_SECRET=... APP_URL=https://имя.workers.dev npm run bot:setup
 */

import { deriveWebhookSecret } from "../src/auth.js";

const { BOT_TOKEN, APP_URL } = process.env;

const missing = Object.entries({ BOT_TOKEN, APP_URL })
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing.length) {
  console.error(`Не заданы: ${missing.join(", ")}\n`);
  console.error("Пример:");
  console.error("  BOT_TOKEN=123:ABC APP_URL=https://aqillych-crm.твой-логин.workers.dev npm run bot:setup");
  process.exit(1);
}

// Тот же секрет вычисляет и Worker — договариваться о нём не нужно.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || (await deriveWebhookSecret(BOT_TOKEN));

const base = APP_URL.replace(/\/+$/, "");

async function call(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

const me = await call("getMe");
console.log(`Бот: @${me.username}`);

await call("setWebhook", {
  url: `${base}/tg/webhook`,
  secret_token: WEBHOOK_SECRET,
  // Лишние типы событий только тратят запросы Worker'а.
  allowed_updates: ["message", "edited_message", "callback_query"],
  drop_pending_updates: true,
});
console.log(`Вебхук: ${base}/tg/webhook`);

await call("setMyCommands", {
  commands: [
    { command: "today", description: "Кому написать сегодня" },
    { command: "plan", description: "План недели" },
    { command: "help", description: "Как пользоваться" },
  ],
});
console.log("Команды: /today, /plan, /help");

await call("setChatMenuButton", {
  menu_button: { type: "web_app", text: "CRM", web_app: { url: base } },
});
console.log("Кнопка меню открывает CRM");

const info = await call("getWebhookInfo");
if (info.last_error_message) {
  console.warn(`\nТelegram жалуется: ${info.last_error_message}`);
} else {
  console.log(`\nГотово. Напиши боту /help.`);
}
