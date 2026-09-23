// Настоящая SQLite с интерфейсом D1: миграцию и запросы с владельцами
// нужно проверять на живой базе, а не на заглушке.
import { DatabaseSync } from "node:sqlite";

export function createD1() {
  const db = new DatabaseSync(":memory:");

  const wrap = (sql) => {
    let args = [];
    const api = {
      bind(...a) { args = a; return api; },
      async all() {
        // node:sqlite отдаёт объекты без прототипа, D1 — обычные.
        return { results: db.prepare(sql).all(...args).map((row) => ({ ...row })) };
      },
      async first() {
        const row = db.prepare(sql).get(...args);
        return row ? { ...row } : null;
      },
      async run() {
        const res = db.prepare(sql).run(...args);
        return { meta: { changes: Number(res.changes ?? 0) } };
      },
    };
    return api;
  };

  return {
    prepare: wrap,
    async batch(statements) {
      const out = [];
      for (const statement of statements) out.push(await statement.run());
      return out;
    },
    // Для подготовки данных в тестах.
    exec(sql) { db.exec(sql); },
    close() { db.close(); },
  };
}

/** Перехватывает исходящие вызовы Telegram и складывает их в массив. */
export function captureTelegram() {
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    sent.push({ url: String(url), method: String(url).split("/").pop(), body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      headers: { "content-type": "application/json" },
    });
  };
  return {
    sent,
    restore() { globalThis.fetch = original; },
    of(method) { return sent.filter((c) => c.method === method); },
  };
}
