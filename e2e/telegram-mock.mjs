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
    const entries = JSON.parse(readFileSync(LOG, "utf8"));
    entries.push({ method, payload: JSON.parse(body || "{}") });
    writeFileSync(LOG, JSON.stringify(entries, null, 2));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: { message_id: entries.length } }));
  });
}).listen(8788, () => console.log("tg mock on 8788"));
