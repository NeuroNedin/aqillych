// Проверка того, что мини-апп открыт настоящим Telegram, а не кем-то,
// кто просто подобрал адрес Worker'а.
//
// Telegram подписывает initData ключом, выведенным из токена бота:
//   secret = HMAC-SHA256(key: "WebAppData", data: botToken)
//   hash   = HMAC-SHA256(key: secret,       data: dataCheckString)
// dataCheckString — все пары «ключ=значение», кроме hash,
// отсортированные по ключу и склеенные переводом строки.

const enc = new TextEncoder();

async function hmac(keyBytes, messageBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, messageBytes));
}

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// Сравнение за постоянное время: по длительности проверки нельзя
// угадывать хеш по одному символу.
function equalHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * @returns {Promise<{ok: true, user: object} | {ok: false, reason: string}>}
 */
const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * Разбираем initData сами, а не через URLSearchParams: тот превращает «+»
 * в пробел, и подпись перестаёт сходиться на значениях, где «+» встречается
 * буквально.
 */
function parseInitData(initData) {
  const pairs = [];
  for (const chunk of initData.split("&")) {
    if (!chunk) continue;
    const eq = chunk.indexOf("=");
    const key = eq === -1 ? chunk : chunk.slice(0, eq);
    const value = eq === -1 ? "" : chunk.slice(eq + 1);
    pairs.push([decode(key), decode(value)]);
  }
  return pairs;
}

const checkString = (pairs, skip) =>
  pairs
    .filter(([k]) => !skip.has(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

export async function verifyInitData(initData, botToken, { maxAgeSeconds = 86400, now = Date.now() } = {}) {
  if (!initData || typeof initData !== "string") return { ok: false, reason: "no_init_data" };
  if (!botToken) return { ok: false, reason: "no_bot_token" };

  const pairs = parseInitData(initData);
  const get = (name) => pairs.find(([k]) => k === name)?.[1];

  const hash = get("hash");
  if (!hash) return { ok: false, reason: "no_hash" };

  const secret = await hmac(enc.encode("WebAppData"), enc.encode(botToken));

  // Поле signature появилось позже hash и в подпись не входит. Клиенты
  // разных версий расходятся в этом, поэтому принимаем оба состава:
  // знание токена требуется в любом случае.
  const skips = [new Set(["hash", "signature"])];
  if (pairs.some(([k]) => k === "signature")) skips.push(new Set(["hash"]));

  let matched = false;
  for (const skip of skips) {
    const expected = toHex(await hmac(secret, enc.encode(checkString(pairs, skip))));
    if (equalHex(expected, hash.toLowerCase())) {
      matched = true;
      break;
    }
  }
  // Имена полей не секретны, а разобраться по ним можно быстро:
  // видно, какой клиент Telegram и какой набор полей прислал.
  if (!matched) return { ok: false, reason: "bad_signature", fields: pairs.map(([k]) => k).sort() };

  // Подпись верна, но данные могли утечь и быть переиспользованы позже.
  const authDate = Number(get("auth_date"));
  if (!Number.isFinite(authDate)) return { ok: false, reason: "no_auth_date" };
  const ageSeconds = Math.floor(now / 1000) - authDate;
  if (ageSeconds > maxAgeSeconds) return { ok: false, reason: "expired" };
  // Дата из будущего — либо подделка, либо часы ушли; небольшой запас допускаем.
  if (ageSeconds < -300) return { ok: false, reason: "future_auth_date" };

  let user;
  try {
    user = JSON.parse(get("user") || "null");
  } catch {
    return { ok: false, reason: "bad_user" };
  }
  if (!user || typeof user.id !== "number") return { ok: false, reason: "no_user" };

  return { ok: true, user };
}

/**
 * Секрет вебхука выводится из токена бота, а не задаётся руками:
 * одно значение меньше при установке и нечего потерять между шагами.
 * Подобрать его, не зная токена, нельзя — а токен знают только
 * владелец бота и Telegram.
 */
export async function deriveWebhookSecret(botToken) {
  if (!botToken) return "";
  return toHex(await hmac(enc.encode(botToken), enc.encode("telegram-webhook-v1")));
}

// Сравнение hex-строк за постоянное время — годится и для секрета вебхука.
export const equalSecret = equalHex;

// Собирает подписанный initData — нужен только тестам.
export async function signInitData(fields, botToken, { signedFields } = {}) {
  const pairs = Object.entries(fields);
  // signedFields — какие поля вошли в подпись; по умолчанию все,
  // кроме signature, как это делает Telegram.
  const skip = new Set(["hash"]);
  if (!signedFields) skip.add("signature");
  else for (const [k] of pairs) if (!signedFields.includes(k)) skip.add(k);

  const secret = await hmac(enc.encode("WebAppData"), enc.encode(botToken));
  const hash = toHex(await hmac(secret, enc.encode(checkString(pairs, skip))));

  return pairs
    .concat([["hash", hash]])
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}
