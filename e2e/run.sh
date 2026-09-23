#!/usr/bin/env bash
# Сквозная проверка: поднимает локальный Worker с чистой базой,
# подменяет Telegram заглушкой и прогоняет три набора проверок.
#
#   ./e2e/run.sh          — API и бот
#   ./e2e/run.sh --ui     — плюс проверки в браузере (нужен playwright)
set -euo pipefail

cd "$(dirname "$0")/.."
PORT=8787
MOCK_PORT=8788
WORK=$(mktemp -d)
CALLS="$WORK/tg-calls.json"
trap 'kill ${WORKER_PID:-} ${MOCK_PID:-} 2>/dev/null || true; rm -rf "$WORK"' EXIT

if [ ! -f .dev.vars ]; then
  echo "Нет .dev.vars — скопируй .dev.vars.example и заполни." >&2
  exit 1
fi

echo '[]' > "$CALLS"
node e2e/telegram-mock.mjs "$CALLS" & MOCK_PID=$!

# Если порт занят чужим процессом, заглушка молча умрёт, а проверки
# будут смотреть в пустой файл и «падать» без причины.
for _ in $(seq 1 20); do
  curl -s -o /dev/null -X POST "http://localhost:$MOCK_PORT/bot/ping" -d '{}' && break
  sleep 0.5
done
if ! curl -s -o /dev/null -X POST "http://localhost:$MOCK_PORT/bot/ping" -d '{}'; then
  echo "Заглушка Telegram не отвечает на порту $MOCK_PORT — возможно, он занят." >&2
  echo "Что держит порт:" >&2
  ss -lptn "sport = :$MOCK_PORT" >&2 || true
  exit 1
fi
echo '[]' > "$CALLS"

# Схему создаёт и обновляет сам Worker, поэтому начинаем с пустой базы.
rm -rf .wrangler/state

npx wrangler dev --port "$PORT" --local > "$WORK/wrangler.log" 2>&1 & WORKER_PID=$!
for _ in $(seq 1 60); do
  curl -s -o /dev/null "http://localhost:$PORT/" && break
  sleep 1
done
if ! curl -s -o /dev/null "http://localhost:$PORT/"; then
  echo "Worker не поднялся на порту $PORT:" >&2
  tail -20 "$WORK/wrangler.log" >&2
  exit 1
fi

# Владелец и привязка переживают очистку: иначе проверки начинались бы
# с чужого состояния — без доступа и с неизвестным Telegram адресом.
wipe_data() {
  npx wrangler d1 execute crm --local --command \
    "DELETE FROM leads; DELETE FROM log; DELETE FROM invites; DELETE FROM users WHERE id <> '555'; DELETE FROM meta WHERE key LIKE 'undo:%';" \
    > /dev/null
}

echo "=== API ==="
node e2e/api.mjs "$CALLS"

wipe_data
echo '[]' > "$CALLS"
echo "=== Бот ==="
node e2e/bot.mjs "$CALLS"

if [ "${1:-}" = "--ui" ]; then
  wipe_data
  echo "=== Браузер ==="
  # Снимки экрана кладём рядом с проектом: по ним видно, что получилось.
  mkdir -p .e2e-shots
  node e2e/ui.mjs .e2e-shots
  echo "Снимки экрана: .e2e-shots/"
fi

echo "Всё прошло."
