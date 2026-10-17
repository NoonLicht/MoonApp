# Подписи интерфейса «Документов»

Лента, меню и диалоги страницы «Документы» подписаны по английским ключам.

- `cat/<язык>.json` — каталоги переводов проекта **WordCraft**
  (<https://github.com/storytold/wordcraft>, лицензия MIT OR Apache-2.0,
  `crates/ui-egui/src/i18n/*.tsv`). По заявлению авторов, они написаны с нуля, без строк
  Microsoft Word. Генерируются командой `node scripts/genWordCatalog.mjs` (нужна сборка
  ядра `npm run build:wordcore`, после неё исходники лежат в `~/.cargo/git/checkouts`).
  Языки: ru, es, fr, zh. Для остальных показывается английский.
- `extra/<язык>.json` — наши собственные подписи, которых нет в каталоге WordCraft.
  Тест `tests/wordRibbon.test.ts` следит, чтобы каждая подпись ленты была переведена на русский.

Копия лицензий WordCraft: `LICENSE-MIT` и `LICENSE-APACHE` в репозитории проекта.
