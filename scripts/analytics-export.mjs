// Экспорт снимка аналитики из PostHog в Markdown-отчёт.
//
// Живые дашборды (воронки, retention-когорты) смотрим в UI PostHog; этот скрипт
// нужен как читаемый датированный файл «положить/переслать/сохранить».
//
// Тянет метрики через PostHog Query API (HogQL) и пишет analytics-export/<дата>.md.
// Запуск: npm run analytics:export  (подхватывает .env.local через --env-file).
//
// Нужны env: POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID, POSTHOG_HOST.
// Период в днях — необязательный аргумент (по умолчанию 30): npm run analytics:export -- 7
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const HOST = (process.env.POSTHOG_HOST || "https://eu.posthog.com").replace(/\/+$/, "");
const PROJECT = process.env.POSTHOG_PROJECT_ID;
const KEY = process.env.POSTHOG_PERSONAL_API_KEY;
const DAYS = Number(process.argv[2]) || 30;

if (!KEY || !PROJECT) {
  console.error(
    "Не заданы POSTHOG_PERSONAL_API_KEY и/или POSTHOG_PROJECT_ID.\n" +
      "Положи их в .env.local (см. .env.example) и запусти `npm run analytics:export`.",
  );
  process.exit(1);
}

/** Выполнить HogQL-запрос, вернуть { columns, results }. */
async function runQuery(query) {
  const res = await fetch(`${HOST}/api/projects/${PROJECT}/query/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
  });
  if (!res.ok) {
    throw new Error(`PostHog API ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/** Markdown-таблица из columns + строк. */
function table(columns, rows) {
  if (!rows.length) return "_нет данных за период_\n";
  const head = `| ${columns.join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map((c) => (c ?? "")).join(" | ")} |`).join("\n");
  return `${head}\n${sep}\n${body}\n`;
}

const SINCE = `now() - INTERVAL ${DAYS} DAY`;

// [заголовок секции, HogQL]. Каждая секция считается независимо: сбой одной не
// валит весь отчёт.
const sections = [
  [
    "Комнаты по дням (room_session)",
    `SELECT toDate(timestamp) AS day, count() AS rooms
     FROM events WHERE event = 'room_session' AND timestamp >= ${SINCE}
     GROUP BY day ORDER BY day`,
  ],
  [
    "Сводка по комнатам",
    `SELECT count() AS sessions,
            round(avg(toFloat(properties.peak_participants)), 2) AS avg_peak,
            max(toInt(properties.peak_participants)) AS max_peak,
            round(avg(toFloat(properties.total_unique)), 2) AS avg_unique,
            round(avg(toFloat(properties.duration_sec)) / 60, 1) AS avg_minutes
     FROM events WHERE event = 'room_session' AND timestamp >= ${SINCE}`,
  ],
  [
    "Распределение пика одновременных",
    `SELECT toInt(properties.peak_participants) AS peak, count() AS rooms
     FROM events WHERE event = 'room_session' AND timestamp >= ${SINCE}
     GROUP BY peak ORDER BY peak`,
  ],
  [
    "Создатели и входы по ссылке (k-фактор)",
    `SELECT count(DISTINCT if(event = 'room_created', person_id, NULL)) AS creators,
            count(DISTINCT if(event = 'room_joined' AND properties.entry = 'link', person_id, NULL)) AS link_joiners,
            round(link_joiners / nullIf(creators, 0), 2) AS k_factor
     FROM events WHERE event IN ('room_created', 'room_joined') AND timestamp >= ${SINCE}`,
  ],
  [
    "Недельное удержание (W1)",
    `SELECT count(DISTINCT prev.person_id) AS prev_week_joiners,
            count(DISTINCT cur.person_id) AS returned,
            round(count(DISTINCT cur.person_id) / nullIf(count(DISTINCT prev.person_id), 0), 2) AS retention
     FROM (SELECT DISTINCT person_id FROM events
           WHERE event = 'room_joined'
             AND timestamp >= now() - INTERVAL 14 DAY AND timestamp < now() - INTERVAL 7 DAY) AS prev
     LEFT JOIN (SELECT DISTINCT person_id FROM events
                WHERE event = 'room_joined' AND timestamp >= now() - INTERVAL 7 DAY) AS cur
       ON prev.person_id = cur.person_id`,
  ],
];

const today = new Date().toISOString().slice(0, 10);
const lines = [
  `# Аналитика Game Room — снимок ${today}`,
  "",
  `Период: последние ${DAYS} дн. Источник: PostHog (${HOST}).`,
  "Живые дашборды и retention-когорты — в UI PostHog; здесь читаемый снимок.",
  "",
];

for (const [title, query] of sections) {
  lines.push(`## ${title}`, "");
  try {
    const { columns, results } = await runQuery(query);
    lines.push(table(columns ?? [], results ?? []));
  } catch (err) {
    lines.push(`> ⚠️ Не удалось получить данные: ${err.message}`, "");
  }
}

const outDir = join(root, "analytics-export");
const outFile = join(outDir, `${today}.md`);
await mkdir(outDir, { recursive: true });
await writeFile(outFile, lines.join("\n"), "utf8");
console.log(`[analytics] отчёт записан: analytics-export/${today}.md`);
