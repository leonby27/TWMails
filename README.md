# TWMails

HTML-письма Timeweb + автоматический pipeline превращения inline SVG в PNG для совместимости с Gmail / Outlook.

**Превью:** [leonby27.github.io/TWMails](https://leonby27.github.io/TWMails/)

---

## Структура

```
.
├── index.html                       — превью-вьювер (генерируется частично: nav из метаданных)
├── EMAIL_RULES.md                   — общие правила вёрстки писем
├── CONCEPT_designv2.md              — концепт экспериментального дизайна v2
├── testdesign.md                    — журнал направлений
├── img/                             — PNG-иконки (имена по sha256 контента, генерятся скриптом)
├── templates/                       — заготовки для новых писем
├── scripts/build-prod.js            — pipeline: SVG→PNG + регенерация sidebar
├── .github/workflows/build-prod.yml — CI, запускает скрипт на push
├── package.json                     — sharp зависимость
└── <Папка кампании>/
    └── <Письмо>.html                — preview (с inline <svg>)
    └── <Письмо> production.html     — production (генерится автоматически)
```

---

## Как добавить новое письмо

1. Создаёшь HTML в подходящей папке (или новую папку для новой кампании).
2. В `<head>` добавляешь метаданные:

   ```html
   <title>Внутренний заголовок документа</title>
   <meta name="x-mail-group" content="Велком-цепочка">         <!-- обязательно: группа в сайдбаре -->
   <meta name="x-mail-group-order" content="2">                <!-- опционально: порядок групп (меньше = выше) -->
   <meta name="x-mail-title" content="Хороший старт!">         <!-- опционально: заголовок в сайдбаре (fallback: <title>) -->
   <meta name="x-mail-date" content="2026-05-27">              <!-- опционально: YYYY-MM-DD, отображается под заголовком -->
   <meta name="x-mail-order" content="1">                      <!-- опционально: порядок внутри группы -->
   ```

3. Иконки и логотипы используй как inline `<svg width="..." height="...">`. `width`/`height` атрибуты **обязательны** — без них скрипт не сможет растеризовать.
4. `git push`.

**Всё остальное делает CI:**
- Видит изменение → запускает `npm run build`.
- Каждый уникальный SVG → PNG в `img/icon-<hash>.png` (дедупликация по содержимому).
- Создаёт `<имя> production.html` рядом с preview.
- Перегенерирует блок `<!-- NAV:START -->...<!-- NAV:END -->` в `index.html` из метаданных.
- Коммитит обратно с `[skip ci]`.

---

## Локальный dev

```bash
npm install          # один раз — поставит sharp
npm run build        # перегенерить production-файлы + nav
```

Превью открываешь напрямую `open index.html` или из `python3 -m http.server` (для CORS-friendly iframe).

---

## Особенности

- **PNG-имена детерминированы** (sha256 контента). Одинаковые иконки в разных письмах = один PNG.
- **Удаление устаревших PNG**: скрипт удаляет `img/icon-*.png`, на которые больше никто не ссылается.
- **Скрипт пропускает**: `index.html`, файлы с `" production.html"` в имени, папки `templates/`, `scripts/`, `node_modules/`, `img/`, `.github/`.
- **Без `x-mail-group`** письмо обрабатывается (production-файл создастся), но в сайдбаре не появится.
- **Базовый URL для PNG** регулируется env-переменной `PROD_BASE_URL`. По умолчанию — GitHub Pages. Перед массовой рассылкой имеет смысл переехать на постоянный CDN.

---

## Правила и концепты

- [`EMAIL_RULES.md`](EMAIL_RULES.md) — боевой свод правил вёрстки писем.
- [`CONCEPT_designv2.md`](CONCEPT_designv2.md) — экспериментальный концепт (тёмный hero + duotone-иконки + светлые карточки).
- [`testdesign.md`](testdesign.md) — журнал направлений эксперимента.
