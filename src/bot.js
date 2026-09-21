// Логика Telegram-бота: приём списков, утренний дайджест, быстрый статус.

import { parseList, contactUrl } from "./parse.js";
import { deriveWebhookSecret } from "./auth.js";
import { getState, bulkAdd, getMeta, setMeta } from "./db.js";
import { CLOSED, PLAN, SOURCE_BY_KEY, countPlan, humanDate, localDate } from "./domain.js";

const MAX_LIST = 10; // сколько человек показывать в сводке, прежде чем свернуть в «и ещё N»

// Адрес API вынесен в переменную, чтобы тесты могли подставить свой сервер.
const apiBase = (env) => env.TELEGRAM_API || "https://api.telegram.org/bot";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function callTelegram(env, method, payload) {
  const res = await fetch(`${apiBase(env)}${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => null);
  if (!data?.ok) console.error(`telegram ${method} failed`, data?.description ?? res.status);
  return data;
}

function openButton(env, label = "Открыть CRM") {
  if (!env.APP_URL) return undefined;
  return { inline_keyboard: [[{ text: label, web_app: { url: env.APP_URL } }]] };
}

export function sendMessage(env, chatId, text, extra = {}) {
  return callTelegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}

/* ---------- тексты ---------- */

function personLine(lead, tail) {
  const url = contactUrl(lead.contact);
  const contact = lead.contact ? (url ? ` · <a href="${esc(url)}">${esc(lead.contact)}</a>` : ` · ${esc(lead.contact)}`) : "";
  const niche = lead.niche ? ` — ${esc(lead.niche)}` : "";
  return `• <b>${esc(lead.name)}</b>${contact}${niche}${tail ? ` — ${tail}` : ""}`;
}

function listBlock(title, leads, tailFor) {
  if (!leads.length) return "";
  const shown = leads.slice(0, MAX_LIST).map((l) => personLine(l, tailFor?.(l)));
  const more = leads.length > MAX_LIST ? `\n<i>…и ещё ${leads.length - MAX_LIST}</i>` : "";
  return `${title} — ${leads.length}:\n${shown.join("\n")}${more}`;
}

function planLine(log) {
  const counts = countPlan(log);
  return PLAN.map((p) => `${p.t.toLowerCase()} ${counts[p.k]}/${p.goal}`).join(" · ");
}

// Общая сводка «что сегодня»: просрочки, касания на сегодня, очередь, план.
async function buildStatus(env, today, { greeting = "" } = {}) {
  const { leads, log } = await getState(env.DB, today);

  const active = leads.filter((l) => !CLOSED.has(l.status));
  const late = active.filter((l) => l.next && l.next < today).sort((a, b) => (a.next < b.next ? -1 : 1));
  const due = active.filter((l) => l.next === today);
  const queue = leads.filter((l) => (l.status || "new") === "new");

  const parts = [];
  if (greeting) parts.push(greeting);
  parts.push(listBlock("🔴 Просрочено", late, (l) => `с ${humanDate(l.next, today)}`));
  parts.push(listBlock("🟡 Коснуться сегодня", due));

  if (!late.length && !due.length) {
    parts.push("Касаний на сегодня нет — хороший день, чтобы написать первые сообщения.");
  }

  if (queue.length) {
    const bySource = {};
    for (const l of queue) {
      const key = SOURCE_BY_KEY[l.source] ? l.source : "cold";
      bySource[key] = (bySource[key] || 0) + 1;
    }
    const breakdown = Object.entries(bySource)
      .map(([k, n]) => `${SOURCE_BY_KEY[k].t.toLowerCase()} ${n}`)
      .join(", ");
    parts.push(`📥 Ждут первого сообщения: <b>${queue.length}</b> (${breakdown})`);
  }

  parts.push(`📊 План недели: ${planLine(log)}`);
  return parts.filter(Boolean).join("\n\n");
}

async function buildPlan(env, today) {
  const { log } = await getState(env.DB, today);
  const counts = countPlan(log);
  const rows = PLAN.map((p) => {
    const value = counts[p.k];
    const filled = Math.min(10, Math.round((value / p.goal) * 10));
    const bar = "█".repeat(filled) + "░".repeat(10 - filled);
    const done = value >= p.goal ? " ✓" : "";
    return `${bar}  ${p.t} ${value}/${p.goal}${done}`;
  });
  return `<b>План недели</b>\n<code>${rows.join("\n")}</code>`;
}

/* ---------- добавление списком ---------- */

// Короткий ключ, под которым лежат id последней добавленной пачки,
// чтобы «Отменить» уместилось в 64 байта callback_data.
const undoToken = () => Math.random().toString(36).slice(2, 10);

async function handleList(env, chatId, text, today) {
  const rows = parseList(text);
  if (!rows.length) {
    await sendMessage(env, chatId, "Не разобрал ни одной строки. Формат: <code>Имя — @ник — ниша</code>, по одному человеку на строку.");
    return;
  }

  const nowIso = new Date().toISOString();
  const { added, skipped, created } = await bulkAdd(env.DB, rows, { source: "cold", niche: "", today, nowIso });

  if (!added) {
    await sendMessage(env, chatId, `Все ${skipped} уже есть в базе — ничего не добавил.`);
    return;
  }

  // Кнопка «Отменить» должна знать, что именно появилось.
  const token = undoToken();
  await setMeta(env.DB, `undo:${token}`, created.map((r) => r.id).join(","));

  const names = created.slice(0, MAX_LIST).map((r) => `• ${esc(r.name)}`).join("\n");
  const more = created.length > MAX_LIST ? `\n<i>…и ещё ${created.length - MAX_LIST}</i>` : "";
  const dupes = skipped ? `\nУже были в базе: ${skipped}.` : "";

  await sendMessage(env, chatId, `Добавил <b>${added}</b> — в очередь «Кому написать», источник «Холодный».\n\n${names}${more}${dupes}`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "↩️ Отменить", callback_data: `undo:${token}` }],
        ...(env.APP_URL ? [[{ text: "Открыть CRM", web_app: { url: env.APP_URL } }]] : []),
      ],
    },
  });
}

async function handleUndo(env, query, token) {
  const stored = await getMeta(env.DB, `undo:${token}`);
  const ids = (stored || "").split(",").filter(Boolean);

  if (!ids.length) {
    await callTelegram(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Отменять уже нечего" });
    return;
  }

  const placeholders = ids.map(() => "?").join(",");
  const res = await env.DB.prepare(`DELETE FROM leads WHERE id IN (${placeholders})`).bind(...ids).run();
  await setMeta(env.DB, `undo:${token}`, "");

  await callTelegram(env, "answerCallbackQuery", { callback_query_id: query.id, text: `Убрал ${res.meta?.changes ?? 0}` });
  await callTelegram(env, "editMessageText", {
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    text: `↩️ Отменено: убрал ${res.meta?.changes ?? 0} из базы.`,
    parse_mode: "HTML",
  });
}

/* ---------- роутинг ---------- */

const HELP = `Я держу твою базу потенциальных клиентов.

<b>Добавить людей</b> — просто пришли списком, по одному на строку:
<code>Ахмад — @ahmad_arabic — арабский
Иса | t.me/isa_coach | борьба
@yusuf_finance</code>
Разделители: тире, <code>|</code> или <code>;</code>. Можно только ник или ссылку. Дубли отсеиваю сам.

<b>Команды</b>
/today — кому написать сегодня
/plan — прогресс по неделе
/help — эта справка

Каждое утро присылаю сводку сам.`;

export async function handleUpdate(env, update) {
  const ownerId = Number(env.OWNER_ID);
  const today = localDate(Number(env.TZ_OFFSET ?? 0));

  if (update.callback_query) {
    const query = update.callback_query;
    if (query.from?.id !== ownerId) {
      await callTelegram(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Доступ закрыт" });
      return;
    }
    const data = String(query.data || "");
    if (data.startsWith("undo:")) await handleUndo(env, query, data.slice(5));
    else await callTelegram(env, "answerCallbackQuery", { callback_query_id: query.id });
    return;
  }

  const message = update.message ?? update.edited_message;
  if (!message) return;

  const chatId = message.chat.id;
  if (message.from?.id !== ownerId) {
    await sendMessage(env, chatId, "Этот бот личный — доступ закрыт.");
    return;
  }

  const text = (message.text ?? message.caption ?? "").trim();
  if (!text) {
    await sendMessage(env, chatId, "Жду список людей текстом. /help — как это выглядит.");
    return;
  }

  const command = text.match(/^\/([a-z_]+)/i)?.[1]?.toLowerCase();

  switch (command) {
    case "start":
      await sendMessage(env, chatId, `Готов к работе.\n\n${HELP}`, { reply_markup: openButton(env) });
      return;
    case "help":
      await sendMessage(env, chatId, HELP, { reply_markup: openButton(env) });
      return;
    case "today":
      await sendMessage(env, chatId, await buildStatus(env, today), { reply_markup: openButton(env) });
      return;
    case "plan":
      await sendMessage(env, chatId, await buildPlan(env, today), { reply_markup: openButton(env) });
      return;
    default:
      if (command) {
        await sendMessage(env, chatId, "Не знаю такой команды. /help — что я умею.");
        return;
      }
  }

  await handleList(env, chatId, text, today);
}

/* ---------- привязка бота к приложению ---------- */

/**
 * Связать бота с приложением можно только зная адрес приложения, а оно
 * узнаёт свой адрес само — из запроса, которым его открыли. Поэтому
 * вебхук, кнопка меню и команды настраиваются при первом входе в мини-апп,
 * а не руками по ссылкам.
 */
export async function wireBot(env, origin) {
  if (!env.BOT_TOKEN || !origin) return { wired: false, reason: "нет токена или адреса" };

  const secret = env.WEBHOOK_SECRET || (await deriveWebhookSecret(env.BOT_TOKEN));

  const webhook = await callTelegram(env, "setWebhook", {
    url: `${origin}/tg/webhook`,
    secret_token: secret,
    allowed_updates: ["message", "edited_message", "callback_query"],
  });
  // Без успешного вебхука бот бесполезен, поэтому дальше идём только при нём.
  if (!webhook?.ok) return { wired: false, reason: webhook?.description ?? "Telegram отказал" };

  await callTelegram(env, "setChatMenuButton", {
    menu_button: { type: "web_app", text: "CRM", web_app: { url: origin } },
  });
  await callTelegram(env, "setMyCommands", {
    commands: [
      { command: "today", description: "Кому написать сегодня" },
      { command: "plan", description: "План недели" },
      { command: "help", description: "Как пользоваться" },
    ],
  });

  return { wired: true };
}

/* ---------- утренний дайджест ---------- */

export async function sendDigest(env, today) {
  const greeting = `Доброе утро. Сегодня ${humanDate(today, today)}.`;
  const text = await buildStatus(env, today, { greeting });
  await sendMessage(env, env.OWNER_ID, text, { reply_markup: openButton(env, "Открыть CRM") });
}
