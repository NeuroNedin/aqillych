// Поддельный Telegram API: записывает всё, что бот пытается отправить.
import { createServer } from "node:http";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const LOG = process.argv[2];
if (!existsSync(LOG)) writeFileSync(LOG, "[]");

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const method = req.url.split("/").pop();
    const payload = JSON.parse(body || "{}");
    const entries = JSON.parse(readFileSync(LOG, "utf8"));
    entries.push({ method, payload });
    writeFileSync(LOG, JSON.stringify(entries, null, 2));

    // Отвечаем как настоящий Telegram там, где ответ что-то значит.
    let result = { message_id: entries.length };
    if (method === "getMe") {
      result = { id: 123456, is_bot: true, username: "test_crm_bot" };
    } else if (method === "getWebhookInfo") {
      const last = entries.filter((e) => e.method === "setWebhook").pop();
      result = { url: last?.payload.url ?? "", pending_update_count: 0 };
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result }));
  });
}).listen(8788, () => console.log("tg mock on 8788"));
