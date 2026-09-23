// Логика Telegram-бота: приём списков, утренняя сводка, быстрый статус,
// а также вход по коду приглашения и раздача кодов владельцем.

import { parseList, contactUrl } from "./parse.js";
import {
  getState, bulkAdd, getUser, createUser, touchUserProfile,
  createInvite, listInvites, redeemInvite, deleteInvite, listUsers,
  getMeta, setMeta,
} from "./db.js";
import { CLOSED, PLAN, SOURCE_BY_KEY, countPlan, humanDate, localDate } from "./domain.js";
import { deriveWebhookSecret } from "./auth.js";

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

// Строки с целью 0 человек скрыл — их не показываем.
const activeGoals = (person) => PLAN.filter((p) => (person.goals[p.k] ?? 0) > 0);

function planLine(person, log) {
  const counts = countPlan(log);
  const rows = activeGoals(person);
  if (!rows.length) return "цели не заданы";
  return rows.map((p) => `${p.t.toLowerCase()} ${counts[p.k]}/${person.goals[p.k]}`).join(" · ");
}

async function buildStatus(env, person, today, { greeting = "" } = {}) {
  const { leads, log } = await getState(env.DB, person.id, today);

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

  parts.push(`📊 План недели: ${planLine(person, log)}`);
  return parts.filter(Boolean).join("\n\n");
}

async function buildPlan(env, person, today) {
  const { log } = await getState(env.DB, person.id, today);
  const counts = countPlan(log);
  const rows = activeGoals(person);
  if (!rows.length) return "Цели не заданы. Открой CRM и задай их в настройках.";

  const bars = rows.map((p) => {
    const goal = person.goals[p.k];
    const value = counts[p.k];
    const filled = Math.min(10, Math.round((value / goal) * 10));
    const bar = "█".repeat(filled) + "░".repeat(10 - filled);
    return `${bar}  ${p.t} ${value}/${goal}${value >= goal ? " ✓" : ""}`;
  });
  return `<b>План недели</b>\n<code>${bars.join("\n")}</code>`;
}

/* ---------- добавление списком ---------- */

const undoToken = () => Math.random().toString(36).slice(2, 10);

async function handleList(env, person, chatId, text, today) {
  const rows = parseList(text);
  if (!rows.length) {
    await sendMessage(env, chatId, "Не разобрал ни одной строки. Формат: <code>Имя — @ник — ниша</code>, по одному человеку на строку.");
    return;
  }

  const nowIso = new Date().toISOString();
  const { added, skipped, created } = await bulkAdd(env.DB, person.id, rows, {
    source: "cold", niche: "", today, nowIso,
  });

  if (!added) {
    await sendMessage(env, chatId, `Все ${skipped} уже есть в базе — ничего не добавил.`);
    return;
  }

  const token = undoToken();
  await setMeta(env.DB, `undo:${person.id}:${token}`, created.map((r) => r.id).join(","));

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

async function handleUndo(env, person, query, token) {
  const key = `undo:${person.id}:${token}`;
  const stored = await getMeta(env.DB, key);
  const ids = (stored || "").split(",").filter(Boolean);

  if (!ids.length) {
    await callTelegram(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Отменять уже нечего" });
    return;
  }

  const placeholders = ids.map(() => "?").join(",");
  const res = await env.DB
    .prepare(`DELETE FROM leads WHERE owner = ? AND id IN (${placeholders})`)
    .bind(person.id, ...ids)
    .run();
  await setMeta(env.DB, key, "");

  const removed = res.meta?.changes ?? 0;
  await callTelegram(env, "answerCallbackQuery", { callback_query_id: query.id, text: `Убрал ${removed}` });
  await callTelegram(env, "editMessageText", {
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    text: `↩️ Отменено: убрал ${removed} из базы.`,
    parse_mode: "HTML",
  });
}

/* ---------- приглашения ---------- */

// Без похожих символов: код диктуют голосом и набирают с телефона.
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function makeCode(length = 6) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

const isOwner = (env, id) => String(id) === String(env.OWNER_ID);

async function handleInvite(env, chatId, args, today) {
  // Формат: /invite [сколько человек] [заметка]
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let maxUses = 1;
  if (parts.length && /^\d+$/.test(parts[0])) maxUses = Math.min(100, Math.max(1, Number(parts.shift())));
  const note = parts.join(" ");

  const code = makeCode();
  await createInvite(env.DB, { code, note, maxUses, today });

  const forWhom = note ? ` для «${esc(note)}»` : "";
  const uses = maxUses === 1 ? "на одного человека" : `на ${maxUses} человек`;
  await sendMessage(env, chatId,
    `Код${forWhom} ${uses}:\n\n<code>${code}</code>\n\n` +
    `Перешли его так: «Открой @${env.BOT_USERNAME || "бота"} и отправь ему <code>${code}</code>».`);
}

async function handlePeople(env, chatId) {
  const [people, invites] = await Promise.all([listUsers(env.DB), listInvites(env.DB)]);
  const lines = people.map((p) => {
    const who = p.username ? `@${esc(p.username)}` : esc(p.name || p.id);
    const mark = p.invitedBy === "owner" ? " · владелец" : "";
    return `• ${who}${mark}`;
  });
  const free = invites.filter((i) => i.used < i.max_uses);
  const freeLine = free.length
    ? `\n\nНеиспользованные коды:\n${free.map((i) => `<code>${i.code}</code>${i.note ? ` — ${esc(i.note)}` : ""} (${i.max_uses - i.used} из ${i.max_uses})`).join("\n")}`
    : "\n\nСвободных кодов нет. Создать: /invite";
  await sendMessage(env, chatId, `<b>Пользуются CRM — ${people.length}</b>\n${lines.join("\n")}${freeLine}`);
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

Цели недели, время сводки и прочее меняются в самой CRM, в настройках.`;

const OWNER_HELP = `\n\n<b>Для владельца</b>\n/invite — выдать код доступа\n/people — кто пользуется`;

async function greetStranger(env, chatId) {
  await sendMessage(env, chatId,
    "Это личная CRM для работы с клиентами.\n\n" +
    "Доступ открывается по коду приглашения — пришли его сюда одним сообщением.\n" +
    "Если кода нет, попроси у того, кто дал тебе ссылку на бота.");
}

export async function handleUpdate(env, update) {
  if (update.callback_query) {
    const query = update.callback_query;
    const person = await getUser(env.DB, query.from?.id);
    if (!person) {
      await callTelegram(env, "answerCallbackQuery", { callback_query_id: query.id, text: "Доступа нет" });
      return;
    }
    const data = String(query.data || "");
    if (data.startsWith("undo:")) await handleUndo(env, person, query, data.slice(5));
    else await callTelegram(env, "answerCallbackQuery", { callback_query_id: query.id });
    return;
  }

  const message = update.message ?? update.edited_message;
  if (!message) return;

  const chatId = message.chat.id;
  const from = message.from ?? {};
  const text = (message.text ?? message.caption ?? "").trim();
  const command = text.match(/^\/([a-z_]+)/i)?.[1]?.toLowerCase();
  const args = command ? text.slice(command.length + 1).trim() : "";

  let person = await getUser(env.DB, from.id);

  // Первый вход: владелец проходит без кода, остальные — по приглашению.
  if (!person) {
    const today = localDate(Number(env.TZ_OFFSET ?? 0));

    if (isOwner(env, from.id)) {
      person = await createUser(env.DB, {
        id: from.id, name: from.first_name, username: from.username, invitedBy: "owner", today,
      });
    } else if (command) {
      await greetStranger(env, chatId);
      return;
    } else {
      const redeemed = await redeemInvite(env.DB, text);
      if (!redeemed.ok) {
        await sendMessage(env, chatId, `Не подошло: ${redeemed.reason}. Пришли код одним сообщением, без лишних слов.`);
        return;
      }
      person = await createUser(env.DB, {
        id: from.id, name: from.first_name, username: from.username, invitedBy: redeemed.code, today,
      });
      await sendMessage(env, chatId, `Готово, доступ открыт.\n\n${HELP}`, { reply_markup: openButton(env) });
      return;
    }
  }

  // Имя и ник могли поменяться — держим их свежими для списка владельца.
  if (from.username !== person.username || from.first_name !== person.name) {
    await touchUserProfile(env.DB, person.id, { name: from.first_name, username: from.username });
  }

  const today = localDate(person.tzOffset);
  const owner = isOwner(env, from.id);

  if (!text) {
    await sendMessage(env, chatId, "Жду список людей текстом. /help — как это выглядит.");
    return;
  }

  switch (command) {
    case "start":
      await sendMessage(env, chatId, `Готов к работе.\n\n${HELP}${owner ? OWNER_HELP : ""}`, { reply_markup: openButton(env) });
      return;
    case "help":
      await sendMessage(env, chatId, `${HELP}${owner ? OWNER_HELP : ""}`, { reply_markup: openButton(env) });
      return;
    case "today":
      await sendMessage(env, chatId, await buildStatus(env, person, today), { reply_markup: openButton(env) });
      return;
    case "plan":
      await sendMessage(env, chatId, await buildPlan(env, person, today), { reply_markup: openButton(env) });
      return;
    case "invite":
      if (!owner) { await sendMessage(env, chatId, "Коды выдаёт только владелец."); return; }
      await handleInvite(env, chatId, args, today);
      return;
    case "people":
      if (!owner) { await sendMessage(env, chatId, "Это команда владельца."); return; }
      await handlePeople(env, chatId);
      return;
    case "revoke": {
      if (!owner) { await sendMessage(env, chatId, "Это команда владельца."); return; }
      const res = await deleteInvite(env.DB, args);
      await sendMessage(env, chatId, res.deleted ? "Код отозван." : "Такого кода нет.");
      return;
    }
    default:
      if (command) {
        await sendMessage(env, chatId, "Не знаю такой команды. /help — что я умею.");
        return;
      }
  }

  await handleList(env, person, chatId, text, today);
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

/**
 * Что Telegram думает о нашем боте: под каким именем он известен
 * и куда сейчас ведёт вебхук. Нужно для страницы состояния.
 */
export async function botStatus(env) {
  if (!env.BOT_TOKEN) return { ok: false, reason: "нет BOT_TOKEN" };
  const me = await callTelegram(env, "getMe", {});
  const hook = await callTelegram(env, "getWebhookInfo", {});
  if (!me?.ok) return { ok: false, reason: me?.description ?? "Telegram не ответил" };
  return {
    ok: true,
    username: me.result.username,
    webhookUrl: hook?.result?.url ?? "",
    pending: hook?.result?.pending_update_count ?? 0,
    lastError: hook?.result?.last_error_message ?? "",
  };
}

/* ---------- утренняя сводка ---------- */

export async function sendDigest(env, person, today) {
  const greeting = `Доброе утро. Сегодня ${humanDate(today, today)}.`;
  const text = await buildStatus(env, person, today, { greeting });
  await sendMessage(env, person.id, text, { reply_markup: openButton(env, "Открыть CRM") });
}
