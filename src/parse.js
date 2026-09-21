// Разбор списка людей, введённого строками.
// Один и тот же код работает и в мини-аппе («Добавить списком»),
// и когда список просто кидают боту сообщением.

const URL_PREFIX = /^https?:\/\//i;
const BARE_DOMAIN = /^(t\.me|telegram\.me|instagram\.com|www\.instagram\.com|youtube\.com|www\.youtube\.com|vk\.com|www\.vk\.com)\//i;
const HANDLE = /^@[A-Za-z0-9_]{3,}$/;
const PHONE = /^\+?\d[\d\s()-]{7,}$/;

// Похоже ли это на способ связи, а не на имя или нишу.
export function looksLikeContact(s) {
  return URL_PREFIX.test(s) || BARE_DOMAIN.test(s) || HANDLE.test(s) || PHONE.test(s);
}

// Приводим контакт к виду, по которому ловятся дубли:
// «@ivan», «t.me/ivan» и «https://t.me/ivan/» — один и тот же человек.
export function contactKey(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";

  if (PHONE.test(s)) return `tel:${s.replace(/\D/g, "")}`;
  if (HANDLE.test(s)) return `tg:${s.slice(1).toLowerCase()}`;

  s = s.replace(URL_PREFIX, "").replace(/^www\./i, "");

  const m = s.match(/^(t\.me|telegram\.me|instagram\.com|youtube\.com|vk\.com)\/(?:@)?([^/?#]+)/i);
  if (m) {
    const handle = m[2].toLowerCase();
    if (!handle) return "";
    const host = m[1].toLowerCase();
    const prefix =
      host === "instagram.com" ? "ig:" :
      host === "youtube.com"   ? "yt:" :
      host === "vk.com"        ? "vk:" : "tg:";
    return prefix + handle;
  }

  // Неизвестный адрес: хвост после ? или # ничего не говорит о человеке.
  return s.toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
}

// Ссылка, по которой можно нажать. Пусто — если открывать нечего.
export function contactUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (URL_PREFIX.test(s)) return s;
  if (BARE_DOMAIN.test(s)) return `https://${s}`;
  if (HANDLE.test(s)) return `https://t.me/${s.slice(1)}`;
  return "";
}

// Имя по умолчанию, когда в строке только ссылка или ник.
function nameFromContact(contact) {
  const key = contactKey(contact);
  if (key.startsWith("tg:")) return `@${key.slice(3)}`;
  if (key.startsWith("ig:") || key.startsWith("yt:") || key.startsWith("vk:")) return key.slice(3);
  return contact;
}

// Строка -> {name, contact, niche}. Разделители: тире, «|», «;», таб.
export function parseLine(line) {
  const parts = String(line)
    .split(/\s+[—–-]\s+|\s*[|;\t]\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (!parts.length) return null;

  let contact = "";
  const rest = [];
  for (const p of parts) {
    if (!contact && looksLikeContact(p)) contact = p;
    else rest.push(p);
  }

  const name = (rest.shift() || nameFromContact(contact) || "").trim();
  if (!name && !contact) return null;

  return { name, contact, niche: rest.join(", ") };
}

// Весь текст -> массив записей. Пустые строки пропускаются,
// дубли внутри самой пачки схлопываются.
export function parseList(text) {
  const rows = [];
  const seen = new Set();
  for (const line of String(text || "").split("\n")) {
    const row = parseLine(line.trim());
    if (!row) continue;
    const key = contactKey(row.contact);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    rows.push(row);
  }
  return rows;
}
