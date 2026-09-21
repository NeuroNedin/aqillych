// Точка входа Worker: статика мини-аппа, API для него, вебхук бота и cron.
//
// Страница лежит в ./public и отдаётся Cloudflare напрямую.
// Сюда попадает только то, чего в ./public нет: /api/* и /tg/*.

import { verifyInitData, deriveWebhookSecret, equalSecret } from "./auth.js";
import { handleUpdate, sendDigest, wireBot, botStatus } from "./bot.js";
import { parseList } from "./parse.js";
import { getState, saveLead, deleteLead, markWrote, bulkAdd, getMeta, setMeta } from "./db.js";
import { localDate, localHour, canonicalOrigin, STATUSES, SOURCES, PLAN, FOLLOW_DAYS } from "./domain.js";
import { SCHEMA } from "./schema.js";

// Таблицы создаются сами при первом обращении: так CRM разворачивается
// без командной строки. Флаг живёт, пока жив изолят, — обычно это
// одна проверка на холодный старт.
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
  schemaReady = true;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const today = (env) => localDate(Number(env.TZ_OFFSET ?? 0));

// Мини-апп имеет право на запись только если Telegram подписал его данные
// и за ними стоит владелец из OWNER_ID.
// Причин отказа несколько, и лечатся они по-разному — общий текст
// «не подтвердил вход» заставляет владельца гадать.
const WHY_REFUSED = {
  no_init_data: "Telegram не передал данные входа. Открывай CRM кнопкой в боте, а не по ссылке в браузере.",
  no_hash: "Данные входа пришли без подписи — открой CRM заново кнопкой в боте.",
  bad_signature: "Подпись не сходится. Чаще всего BOT_TOKEN в настройках приложения — от другого бота или скопирован с лишними символами.",
  expired: "Данные входа старше суток. Закрой CRM и открой заново.",
  future_auth_date: "Часы устройства сильно расходятся с реальным временем — проверь дату и время в настройках телефона.",
  no_auth_date: "Данные входа пришли без отметки времени — открой CRM заново кнопкой в боте.",
  bad_user: "Telegram прислал данные, которые не удалось разобрать. Открой CRM заново.",
  no_user: "Telegram не сообщил, кто открыл приложение. Открой CRM кнопкой в боте.",
  no_bot_token: "В настройках приложения не задан BOT_TOKEN.",
};

async function authorize(request, env) {
  const initData = request.headers.get("x-init-data") ?? "";
  const result = await verifyInitData(initData, env.BOT_TOKEN);
  if (!result.ok) {
    const why = WHY_REFUSED[result.reason] ?? "Telegram не подтвердил вход.";
    return { error: json({ error: why, reason: result.reason }, 401) };
  }
  if (String(result.user.id) !== String(env.OWNER_ID)) {
    // Владельцу полезно увидеть собственный номер: обычно это опечатка в OWNER_ID.
    return {
      error: json({
        error: `Доступ закрыт. Приложение ждёт владельца с номером ${env.OWNER_ID}, а вошёл ${result.user.id}.`,
      }, 403),
    };
  }
  return { user: result.user };
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

/**
 * Один раз на адрес: приложение представляется Telegram само.
 * Отметка в базе не даёт делать это на каждый запрос.
 */
async function ensureWired(env, origin) {
  if (await getMeta(env.DB, "wired") === origin) return;
  const result = await wireBot(env, origin);
  if (result.wired) await setMeta(env.DB, "wired", origin);
  else console.error("не удалось связать бота:", result.reason);
}

async function handleApi(request, env, path, ctx) {
  // Пока секреты не добавлены, важнее назвать недостающие поимённо,
  // чем говорить «не настроено».
  const missing = ["BOT_TOKEN", "OWNER_ID"].filter((k) => !env[k]);
  if (missing.length) {
    return json({ error: `Осталось добавить в настройках приложения: ${missing.join(", ")}.` }, 503);
  }

  const auth = await authorize(request, env);
  if (auth.error) return auth.error;

  await ensureSchema(env);

  // Телеграму можно рассказать о себе в фоне — ответ ждать не должен.
  // Адрес берём постоянный: мини-апп могли открыть по адресу сборки.
  const appUrl = publicOrigin(env, new URL(request.url).origin);
  ctx.waitUntil(ensureWired(env, appUrl).catch((err) => console.error("wiring failed", err)));

  const day = today(env);
  const nowIso = new Date().toISOString();
  const state = () => getState(env.DB, day);

  if (path === "/api/state" && request.method === "GET") {
    // Словари едут только при первой загрузке: дальше мини-апп держит их у себя.
    return json({
      ...(await state()),
      today: day,
      dict: { statuses: STATUSES, sources: SOURCES, plan: PLAN, followDays: FOLLOW_DAYS },
    });
  }

  if (request.method !== "POST") return json({ error: "Метод не поддерживается" }, 405);
  const body = await readJson(request);

  switch (path) {
    case "/api/lead": {
      const res = await saveLead(env.DB, body.id || null, body, { today: day, nowIso });
      if (res.error) return json({ error: res.error }, 400);
      return json({ ...(await state()), id: res.id });
    }

    case "/api/lead/delete": {
      if (!body.id) return json({ error: "Не указана карточка" }, 400);
      const res = await deleteLead(env.DB, body.id);
      if (res.error) return json({ error: res.error }, 404);
      return json(await state());
    }

    case "/api/wrote": {
      if (!body.id) return json({ error: "Не указана карточка" }, 400);
      const res = await markWrote(env.DB, body.id, { today: day });
      if (res.error) return json({ error: res.error }, 400);
      return json({ ...(await state()), next: res.next });
    }

    case "/api/bulk": {
      const rows = parseList(body.text || "");
      if (!rows.length) return json({ error: "Не разобрал ни одной строки" }, 400);
      const res = await bulkAdd(env.DB, rows, { source: body.source, niche: body.niche, today: day, nowIso });
      return json({ ...(await state()), added: res.added, skipped: res.skipped });
    }

    default:
      return json({ error: "Не найдено" }, 404);
  }
}

/**
 * Адрес мини-аппа нужен боту для кнопки «Открыть CRM». Задавать его руками
 * не обязательно: Telegram стучится к нам на наш же домен — запоминаем его.
 */
function publicOrigin(env, origin) {
  return env.APP_URL || canonicalOrigin(origin);
}

async function resolveAppUrl(env, origin) {
  const wanted = publicOrigin(env, origin);
  if (env.APP_URL) return env.APP_URL;
  const stored = await getMeta(env.DB, "app_url");
  if (wanted && wanted !== stored) {
    await setMeta(env.DB, "app_url", wanted);
    return wanted;
  }
  return stored ?? "";
}

async function handleWebhook(request, env, ctx) {
  // Адрес вебхука не секрет, поэтому Telegram присылает общий с нами токен.
  // Обычно он выводится из токена бота; заданный вручную WEBHOOK_SECRET
  // имеет приоритет — для тех, кто настроил вебхук по-старому.
  const expected = env.WEBHOOK_SECRET || (await deriveWebhookSecret(env.BOT_TOKEN));
  const given = request.headers.get("x-telegram-bot-api-secret-token");
  if (!expected || !equalSecret(expected, given ?? "")) return new Response("forbidden", { status: 403 });

  await ensureSchema(env);

  const update = await readJson(request);
  const origin = new URL(request.url).origin;

  // Telegram повторяет доставку, если не ответить быстро: отвечаем сразу,
  // а обработку доводим в фоне.
  ctx.waitUntil(
    resolveAppUrl(env, origin)
      .then((appUrl) => handleUpdate({ ...env, APP_URL: appUrl }, update))
      .catch((err) => console.error("update failed", err)),
  );
  return new Response("ok");
}

/* ---------- страница состояния ---------- */

const esc = (v) => String(v ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

/**
 * Открывается без входа и не показывает ни одного секрета — только
 * «задано / не задано» и то, что Telegram сам про нас знает. Нужна,
 * чтобы владелец мог увидеть причину молчания бота, не читая логи.
 */
async function handleHealth(request, env) {
  const origin = publicOrigin(env, new URL(request.url).origin);
  const rows = [];
  const add = (ok, label, note = "") => rows.push({ ok, label, note });

  add(!!env.BOT_TOKEN, "BOT_TOKEN задан", env.BOT_TOKEN ? "" : "добавь его в настройках Worker'а как Secret");
  const ownerHint = env.OWNER_ID
    ? `начинается на ${String(env.OWNER_ID).slice(0, 3)}…, длина ${String(env.OWNER_ID).length} — сверь со своим номером`
    : "добавь его в настройках Worker'а как Secret";
  add(!!env.OWNER_ID, "OWNER_ID задан", ownerHint);
  if (env.WEBHOOK_SECRET) {
    add(false, "WEBHOOK_SECRET лишний", "удали его: приложение вычисляет секрет из токена само");
  }

  let wired = "";
  let wireProblem = "";
  try {
    await ensureSchema(env);
    wired = (await getMeta(env.DB, "wired")) ?? "";
    add(true, "База отвечает");

    // Страницу открывают именно тогда, когда что-то не работает,
    // поэтому она не только показывает беду, но и чинит привязку.
    if (env.BOT_TOKEN && wired !== origin) {
      const result = await wireBot(env, origin);
      if (result.wired) {
        await setMeta(env.DB, "wired", origin);
        wired = origin;
      } else {
        wireProblem = result.reason;
      }
    }
  } catch (err) {
    add(false, "База не отвечает", String(err?.message ?? err));
  }

  add(wired === origin, "Бот знаком с приложением",
    wired === origin ? "" : wireProblem || "не удалось связать — обнови страницу");
  add(true, "Постоянный адрес приложения", origin);

  let status = null;
  if (env.BOT_TOKEN) {
    status = await botStatus(env).catch((err) => ({ ok: false, reason: String(err?.message ?? err) }));
    if (status.ok) {
      const expected = `${origin}/tg/webhook`;
      add(status.webhookUrl === expected, "Telegram шлёт сообщения сюда",
        status.webhookUrl === expected ? "" : status.webhookUrl ? `сейчас шлёт на ${status.webhookUrl}` : "вебхук не настроен");
      if (status.lastError) add(false, "Последняя ошибка Telegram", status.lastError);
    } else {
      add(false, "Telegram не принимает токен", status.reason);
    }
  }

  const allGood = rows.every((r) => r.ok);
  const body = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Состояние CRM</title><style>
:root{color-scheme:light dark;--bg:#F4F5F2;--card:#fff;--ink:#16201C;--muted:#5E6B64;--ok:#1E6A50;--bad:#A83B37;--line:#D8DFD9}
@media(prefers-color-scheme:dark){:root{--bg:#101614;--card:#19211E;--ink:#E6EDE9;--muted:#96A69E;--ok:#4DB38B;--bad:#E27C77;--line:#2E3934}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,system-ui,sans-serif}
.w{max-width:620px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:22px;margin:0 0 4px}
.sum{color:var(--muted);margin:0 0 20px}
ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
li{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;display:flex;gap:10px;align-items:start}
.m{font-weight:700;flex:none;width:1.2em}
.m.y{color:var(--ok)}.m.n{color:var(--bad)}
.t{font-weight:600}
.n2{color:var(--muted);font-size:14px;overflow-wrap:anywhere}
.bot{margin-top:20px;color:var(--muted);font-size:14px}
</style></head><body><div class="w">
<h1>${allGood ? "Всё на месте" : "Нужно поправить"}</h1>
<p class="sum">${allGood ? "Бот и приложение связаны. Напиши боту /start." : "Ниже отмечено, что мешает боту работать."}</p>
<ul>${rows.map((r) => `<li><span class="m ${r.ok ? "y" : "n"}">${r.ok ? "✓" : "✕"}</span><span><span class="t">${esc(r.label)}</span>${r.note ? `<br><span class="n2">${esc(r.note)}</span>` : ""}</span></li>`).join("")}</ul>
${status?.ok ? `<p class="bot">Бот: @${esc(status.username)}${status.pending ? ` · необработанных сообщений: ${status.pending}` : ""}</p>` : ""}
</div></body></html>`;

  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (pathname === "/health") return handleHealth(request, env);
    if (pathname === "/tg/webhook") return handleWebhook(request, env, ctx);
    if (pathname.startsWith("/api/")) return handleApi(request, env, pathname, ctx);

    return new Response("Not found", { status: 404 });
  },

  // Cron ходит каждый час; дайджест уходит один раз в назначенный час.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(maybeSendDigest(env));
  },
};

export async function maybeSendDigest(env, now = new Date()) {
  await ensureSchema(env);
  const offset = Number(env.TZ_OFFSET ?? 0);
  const hour = Number(env.DIGEST_HOUR ?? 9);
  if (localHour(offset, now) !== hour) return { sent: false, reason: "не тот час" };

  const day = localDate(offset, now);
  if ((await getMeta(env.DB, "last_digest")) === day) return { sent: false, reason: "уже отправлен" };

  // Отметку ставим до отправки: лучше пропустить дайджест,
  // чем прислать его дважды, если Telegram ответит с задержкой.
  await setMeta(env.DB, "last_digest", day);
  // У cron нет входящего запроса, поэтому адрес берём из того, что запомнили.
  await sendDigest({ ...env, APP_URL: await resolveAppUrl(env, "") }, day);
  return { sent: true };
}
