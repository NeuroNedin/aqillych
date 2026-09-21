// Точка входа Worker: статика мини-аппа, API для него, вебхук бота и cron.
//
// Страница лежит в ./public и отдаётся Cloudflare напрямую.
// Сюда попадает только то, чего в ./public нет: /api/* и /tg/*.

import { verifyInitData } from "./auth.js";
import { handleUpdate, sendDigest } from "./bot.js";
import { parseList } from "./parse.js";
import { getState, saveLead, deleteLead, markWrote, bulkAdd, getMeta, setMeta } from "./db.js";
import { localDate, localHour, STATUSES, SOURCES, PLAN, FOLLOW_DAYS } from "./domain.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const today = (env) => localDate(Number(env.TZ_OFFSET ?? 0));

// Мини-апп имеет право на запись только если Telegram подписал его данные
// и за ними стоит владелец из OWNER_ID.
async function authorize(request, env) {
  const initData = request.headers.get("x-init-data") ?? "";
  const result = await verifyInitData(initData, env.BOT_TOKEN);
  if (!result.ok) return { error: json({ error: "Telegram не подтвердил вход", reason: result.reason }, 401) };
  if (String(result.user.id) !== String(env.OWNER_ID)) {
    return { error: json({ error: "Доступ закрыт" }, 403) };
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

async function handleApi(request, env, path) {
  if (!env.BOT_TOKEN || !env.OWNER_ID) {
    return json({ error: "Worker не настроен: не заданы BOT_TOKEN или OWNER_ID" }, 500);
  }

  const auth = await authorize(request, env);
  if (auth.error) return auth.error;

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
async function resolveAppUrl(env, origin) {
  if (env.APP_URL) return env.APP_URL;
  const stored = await getMeta(env.DB, "app_url");
  if (origin && origin !== stored) {
    await setMeta(env.DB, "app_url", origin);
    return origin;
  }
  return stored ?? "";
}

async function handleWebhook(request, env, ctx) {
  // Адрес вебхука не секрет, поэтому Telegram присылает общий с нами токен.
  const given = request.headers.get("x-telegram-bot-api-secret-token");
  if (!env.WEBHOOK_SECRET || given !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });

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

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (pathname === "/tg/webhook") return handleWebhook(request, env, ctx);
    if (pathname.startsWith("/api/")) return handleApi(request, env, pathname);

    return new Response("Not found", { status: 404 });
  },

  // Cron ходит каждый час; дайджест уходит один раз в назначенный час.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(maybeSendDigest(env));
  },
};

export async function maybeSendDigest(env, now = new Date()) {
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
