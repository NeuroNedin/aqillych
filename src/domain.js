// Словари и правила, общие для мини-аппа и бота.
// Перенесены один в один из артефакта «CRM Али».

// Воронка идёт сверху вниз: порядок задаёт и сортировку в списке,
// и то, что считается движением вперёд.
export const STATUSES = [
  { k: "new",        t: "Новый" },
  { k: "wrote",      t: "Написал" },
  { k: "interested", t: "Заинтересован" },
  { k: "qualified",  t: "Квалифицировал" },
  { k: "call",       t: "Вывел на созвон" },
  { k: "terms",      t: "Согласовал условия" },
  { k: "invoice",    t: "Выставил счёт" },
  { k: "later",      t: "Отложен" },
  { k: "no",         t: "Не подходит" },
];

// Шаги самой воронки, без «Нового» и без тупиков: по ним считается,
// докуда человек дошёл.
export const FUNNEL = ["wrote", "interested", "qualified", "call", "terms", "invoice"];

export const stageIndex = (status) => FUNNEL.indexOf(status);

export const SOURCES = [
  { k: "warm",      t: "Тёплый круг", plan: "warm" },
  { k: "word",      t: "Сарафан",     plan: "warm" },
  { k: "community", t: "Сообщество",  plan: "warm" },
  { k: "partner",   t: "Партнёр",     plan: "partner" },
  { k: "cold",      t: "Холодный",    plan: "cold" },
  { k: "inbound",   t: "Входящий",    plan: "" },
  { k: "paid",      t: "Реклама",     plan: "" },
];

// Недельные цели.
export const PLAN = [
  { k: "partner", t: "Партнёры",   goal: 3 },
  { k: "cold",    t: "Холодные",   goal: 30 },
  { k: "call",    t: "Созвоны",    goal: 2 },
  { k: "prepay",  t: "Счета",      goal: 1 },
];

// Статусы, после которых касания больше не нужны.
// «Выставил счёт» сюда не входит: счёт ещё надо дожать до оплаты.
export const CLOSED = new Set(["no"]);

// Через сколько дней после «Написал» напомнить о человеке.
export const FOLLOW_DAYS = 3;

export const STATUS_BY_KEY = Object.fromEntries(STATUSES.map((s) => [s.k, s]));
export const SOURCE_BY_KEY = Object.fromEntries(SOURCES.map((s) => [s.k, s]));

export const isStatus = (k) => Object.hasOwn(STATUS_BY_KEY, k);
export const isSource = (k) => Object.hasOwn(SOURCE_BY_KEY, k);

/* ---------- даты ---------- */
// Сервер живёт в UTC, а «сегодня» должно совпадать с тем, что человек
// видит у себя. Поэтому дату считаем со сдвигом TZ_OFFSET.

const pad = (n) => String(n).padStart(2, "0");

export function localDate(offsetMinutes, now = new Date()) {
  const d = new Date(now.getTime() + offsetMinutes * 60000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function localHour(offsetMinutes, now = new Date()) {
  return new Date(now.getTime() + offsetMinutes * 60000).getUTCHours();
}

export function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Понедельник той недели, в которую попадает дата.
export function mondayOf(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const shift = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - shift);
  return d.toISOString().slice(0, 10);
}

const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

export function humanDate(isoDate, relativeTo) {
  if (!isoDate) return "";
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  const currentYear = relativeTo ? Number(relativeTo.slice(0, 4)) : new Date().getUTCFullYear();
  const year = d.getUTCFullYear() === currentYear ? "" : ` ${d.getUTCFullYear()}`;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year}`;
}

export const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

// Сводка по плану недели из записей журнала.
export function countPlan(logRows) {
  const counts = { warm: 0, partner: 0, cold: 0, call: 0, prepay: 0 };
  for (const e of logRows) {
    if (e.kind === "msg" && e.plan && counts[e.plan] != null) counts[e.plan]++;
    if (e.kind === "call") counts.call++;
    if (e.kind === "prepay") counts.prepay++;
  }
  return counts;
}

/**
 * Постоянный адрес приложения по адресу, которым его открыли.
 *
 * Cloudflare даёт каждой сборке временный адрес вида
 * https://<хеш>-<имя>.<аккаунт>.workers.dev. Снаружи такие адреса
 * закрыты, поэтому привязывать к ним бота нельзя: Telegram получит
 * 403. Отбрасываем префикс версии и получаем постоянный адрес.
 */
export function canonicalOrigin(origin) {
  return String(origin || "").replace(/^(https?:\/\/)[0-9a-f]{8}-(?=[^.]+\.[^.]+\.workers\.dev)/i, "$1");
}
