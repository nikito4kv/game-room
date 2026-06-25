<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Как пользоваться graphify

`graphify` — структурный AST-индекс кодовой базы (классы, функции, импорты, граф вызовов). Индекс лежит в `graphify-out/graph.json` и уже собран. Папка `graphify-out/` в `.gitignore` — индекс локальный, в git не коммитится.

**Правила:**

1. **Перед поиском кода — сначала граф.** Если `graphify-out/graph.json` существует, ищи символы через `graphify query graphify-out/graph.json <имя>` прежде чем браться за Grep/Glob. Это главная польза: структурный поиск вместо слепого перебора по ключевым словам.
2. **После правок — обнови индекс, но только если граф понадобится снова в этой же сессии.** Точечно: `graphify update graphify-out/graph.json <файл1> [файл2...]`. Пакетно по `git diff`: `graphify auto-update`. Если граф больше не нужен — не обновляй, следующий `build`/`update` догонит.
3. **Индекс сам не обновляется** — только вручную (`update` / `auto-update` / `build`). Не полагайся на то, что граф свежий после чужих изменений — при сомнении обнови.
4. **Полная пересборка** (`graphify build .`) — когда индекс сильно разошёлся с кодом или его нет.
5. Поддерживаемые типы рёбер: `contains`, `method`, `imports`, `imports_from`, `calls`, `inherits`. Поиск по имени — регистронезависимый.
