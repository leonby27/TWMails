#!/usr/bin/env node
/**
 * build-prod.js
 *
 * Двойная задача:
 *   1) Для каждого preview-HTML с inline <svg> генерит production-версию
 *      (PNG-иконки через sharp, имена по sha256 контента, идемпотентно).
 *   2) Из метаданных <meta name="x-mail-..."> в письмах собирает блок
 *      навигации в корневом index.html (между маркерами NAV:START/NAV:END).
 *
 * Метаданные в письме (в <head>):
 *   <meta name="x-mail-group" content="Велком-цепочка">          (обязательно)
 *   <meta name="x-mail-group-order" content="2">                  (опционально, целое)
 *   <meta name="x-mail-title" content="Хороший старт!">           (опционально, fallback: <title>)
 *   <meta name="x-mail-date" content="2026-05-27">                (опционально, YYYY-MM-DD)
 *   <meta name="x-mail-order" content="1">                        (опционально, порядок в группе)
 *
 * Сканирует .html в репо, пропуская корневой index.html, файлы с
 * " production.html" в имени, а также папки .git, .github, node_modules,
 * img, scripts, templates.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const IMG_DIR = path.join(ROOT, 'img');
const IMG_REL = 'img';
const INDEX_HTML = path.join(ROOT, 'index.html');
const BASE_URL = (process.env.PROD_BASE_URL || 'https://leonby27.github.io/TWMails').replace(/\/+$/, '');

const SKIP_DIRS = new Set(['.git', '.github', 'node_modules', 'img', 'scripts', 'templates']);
const COMPONENTS_DIR = 'components'; // обрабатывается отдельно (без production-конверсии)
const PRODUCTION_SUFFIX = ' production';

const MONTHS_RU = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
];

// ─── Утилиты ─────────────────────────────────────────────────────────────

function findPreviewHTMLs(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name === COMPONENTS_DIR) continue; // компоненты — отдельным шагом
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findPreviewHTMLs(full, results);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      if (full === INDEX_HTML) continue;
      if (entry.name.includes(PRODUCTION_SUFFIX + '.html')) continue;
      results.push(full);
    }
  }
  return results;
}

function findComponentHTMLs() {
  const dir = path.join(ROOT, COMPONENTS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(n => n.endsWith('.html'))
    .map(n => path.join(dir, n));
}

function hashContent(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function extractMeta(html) {
  const meta = {};
  const re = /<meta\s+name=["']x-mail-([^"']+)["']\s+content=["']([^"']*)["']\s*\/?\s*>/g;
  let m;
  while ((m = re.exec(html)) !== null) meta[m[1]] = m[2];
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/);
  meta._docTitle = titleMatch ? titleMatch[1].trim() : null;
  return meta;
}

function extractComponentMeta(html) {
  const meta = {};
  const re = /<meta\s+name=["']x-component-([^"']+)["']\s+content=["']([^"']*)["']\s*\/?\s*>/g;
  let m;
  while ((m = re.exec(html)) !== null) meta[m[1]] = m[2];
  return meta;
}

function formatDate(iso) {
  // "2026-05-28" → "28 мая 2026"
  const m = iso && iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso || '';
  const y = m[1], mo = parseInt(m[2], 10) - 1, d = parseInt(m[3], 10);
  return `${d} ${MONTHS_RU[mo] || ''} ${y}`.trim();
}

// ─── 1. Сборка production HTML + PNG ──────────────────────────────────────

async function rasterize(svgString, displayW, displayH, outPath) {
  const scale = 3;
  await sharp(Buffer.from(svgString), { density: 384 })
    .resize(displayW * scale, displayH * scale)
    .png({ compressionLevel: 9 })
    .toFile(outPath);
}

async function buildProduction(srcPath, manifest) {
  let html = fs.readFileSync(srcPath, 'utf8');
  const svgRegex = /<svg\b([^>]*)>([\s\S]*?)<\/svg>/g;
  const matches = [];
  let m;
  while ((m = svgRegex.exec(html)) !== null) {
    matches.push({ full: m[0], attrs: m[1], index: m.index });
  }
  if (matches.length === 0) return null; // production-файл не нужен

  fs.mkdirSync(IMG_DIR, { recursive: true });
  matches.reverse();
  let generated = 0, reused = 0, skipped = 0;
  for (const match of matches) {
    const wMatch = match.attrs.match(/\bwidth=["'](\d+)["']/);
    const hMatch = match.attrs.match(/\bheight=["'](\d+)["']/);
    if (!wMatch || !hMatch) { skipped++; continue; }
    const w = parseInt(wMatch[1], 10);
    const h = parseInt(hMatch[1], 10);
    const hash = hashContent(match.full);
    const filename = `icon-${hash}.png`;
    const outPath = path.join(IMG_DIR, filename);
    if (!fs.existsSync(outPath)) {
      await rasterize(match.full, w, h, outPath);
      generated++;
    } else {
      reused++;
    }
    manifest.add(filename);
    const imgTag = `<img src="${BASE_URL}/${IMG_REL}/${filename}" width="${w}" height="${h}" alt="" border="0" style="display: block;">`;
    html = html.slice(0, match.index) + imgTag + html.slice(match.index + match.full.length);
  }

  const baseName = path.basename(srcPath, '.html');
  const outName = `${baseName}${PRODUCTION_SUFFIX}.html`;
  const outPath = path.join(path.dirname(srcPath), outName);
  fs.writeFileSync(outPath, html);
  console.log(`  ${path.relative(ROOT, outPath)} (PNG: +${generated} new, ${reused} reused${skipped ? ', ' + skipped + ' skipped' : ''})`);
  return outPath;
}

function cleanupOrphans(referenced) {
  if (!fs.existsSync(IMG_DIR)) return;
  let removed = 0;
  for (const file of fs.readdirSync(IMG_DIR)) {
    if (!file.startsWith('icon-') || !file.endsWith('.png')) continue;
    if (!referenced.has(file)) {
      fs.unlinkSync(path.join(IMG_DIR, file));
      removed++;
    }
  }
  if (removed > 0) console.log(`\n🧹 удалено ${removed} устаревших PNG`);
}

// ─── 2. Сборка nav-блока в index.html ─────────────────────────────────────

function navRowHtml(entry, isActive) {
  const cls = isActive ? 'nav-item active' : 'nav-item';
  const dateLine = entry.date
    ? `          <span class="nav-item__date">${escapeText(formatDate(entry.date))}</span>\n`
    : '';
  return [
    `      <div class="nav-row">`,
    `        <a class="${cls}" data-src="${escapeAttr(entry.previewPath)}">`,
    dateLine + `          <span class="nav-item__title">${escapeText(entry.title)}</span>`,
    `        </a>`,
    `        <button class="nav-row__menu-btn" aria-label="Меню" aria-expanded="false" aria-haspopup="true">`,
    `          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>`,
    `        </button>`,
    `        <div class="nav-row__menu" data-open="false" role="menu">`,
    `          <a href="${escapeAttr(entry.productionPath)}" download="${escapeAttr(entry.downloadName)}">Скачать</a>`,
    `        </div>`,
    `      </div>`
  ].join('\n');
}

function buildNavHtml(entries) {
  // entries: [{ group, groupOrder, title, date, order, previewPath, productionPath, downloadName }]
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.group)) groups.set(e.group, { order: 999, items: [] });
    const g = groups.get(e.group);
    if (typeof e.groupOrder === 'number') g.order = Math.min(g.order, e.groupOrder);
    g.items.push(e);
  }
  const sortedGroups = [...groups.entries()].sort((a, b) => {
    if (a[1].order !== b[1].order) return a[1].order - b[1].order;
    return a[0].localeCompare(b[0], 'ru');
  });

  const lines = [];
  let firstItem = true;
  for (let i = 0; i < sortedGroups.length; i++) {
    const [groupName, groupData] = sortedGroups[i];
    if (i > 0) lines.push('');
    lines.push(`      <div class="nav-group">${escapeText(groupName)}</div>`);
    const items = groupData.items.sort((a, b) => {
      const ao = typeof a.order === 'number' ? a.order : 999;
      const bo = typeof b.order === 'number' ? b.order : 999;
      if (ao !== bo) return ao - bo;
      return a.previewPath.localeCompare(b.previewPath, 'ru');
    });
    for (const e of items) {
      lines.push(navRowHtml(e, firstItem));
      firstItem = false;
    }
  }
  return lines.join('\n');
}

function componentRowHtml(entry, isActive) {
  const cls = isActive ? 'nav-item active' : 'nav-item';
  return [
    `      <div class="nav-row">`,
    `        <a class="${cls}" data-src="${escapeAttr(entry.previewPath)}">`,
    `          <span class="nav-item__title">${escapeText(entry.title)}</span>`,
    `        </a>`,
    `        <button class="nav-row__menu-btn" aria-label="Меню" aria-expanded="false" aria-haspopup="true">`,
    `          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>`,
    `        </button>`,
    `        <div class="nav-row__menu" data-open="false" role="menu">`,
    `          <a href="${escapeAttr(entry.previewPath)}" download="${escapeAttr(entry.downloadName)}">Скачать HTML</a>`,
    `        </div>`,
    `      </div>`
  ].join('\n');
}

function buildComponentsNavHtml(entries) {
  const items = entries.sort((a, b) => {
    const ao = typeof a.order === 'number' ? a.order : 999;
    const bo = typeof b.order === 'number' ? b.order : 999;
    if (ao !== bo) return ao - bo;
    return a.title.localeCompare(b.title, 'ru');
  });
  const lines = [];
  for (let i = 0; i < items.length; i++) {
    lines.push(componentRowHtml(items[i], i === 0));
  }
  return lines.join('\n');
}

function replaceBetweenMarkers(html, startMarker, endMarker, replacement) {
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) return null;
  const startLineEnd = html.indexOf('-->', startIdx) + 3;
  const before = html.slice(0, startLineEnd);
  const after = html.slice(endIdx);
  return before + '\n' + replacement + '\n      ' + after;
}

function updateIndex(navHtml, componentsNavHtml) {
  let html = fs.readFileSync(INDEX_HTML, 'utf8');
  let changed = false;
  const nextHtmlA = replaceBetweenMarkers(html, '<!-- NAV:START', '<!-- NAV:END -->', navHtml);
  if (nextHtmlA === null) {
    console.error('  ⚠ index.html не содержит маркеров NAV:START/NAV:END');
  } else if (nextHtmlA !== html) {
    html = nextHtmlA;
    changed = true;
  }
  const nextHtmlB = replaceBetweenMarkers(html, '<!-- COMPONENTS_NAV:START', '<!-- COMPONENTS_NAV:END -->', componentsNavHtml);
  if (nextHtmlB === null) {
    console.error('  ⚠ index.html не содержит маркеров COMPONENTS_NAV:START/END');
  } else if (nextHtmlB !== html) {
    html = nextHtmlB;
    changed = true;
  }
  if (changed) fs.writeFileSync(INDEX_HTML, html);
  return changed;
}

// ─── main ─────────────────────────────────────────────────────────────────

(async () => {
  const files = findPreviewHTMLs(ROOT);
  console.log(`Найдено ${files.length} preview-HTML-файлов`);
  console.log(`Базовый URL для PNG: ${BASE_URL}/${IMG_REL}/`);

  // 1. Production-файлы
  console.log('\n┌─ Production HTML + PNG ─');
  const manifest = new Set();
  const productionMap = new Map(); // srcPath -> production path (relative)
  for (const f of files) {
    const prodPath = await buildProduction(f, manifest);
    if (prodPath) productionMap.set(f, path.relative(ROOT, prodPath));
  }
  cleanupOrphans(manifest);
  console.log('└─');

  // 2. Метаданные писем → mails nav
  console.log('\n┌─ Sidebar nav из метаданных ─');
  const navEntries = [];
  for (const f of files) {
    const html = fs.readFileSync(f, 'utf8');
    const meta = extractMeta(html);
    if (!meta.group) {
      console.warn(`  ⏭  ${path.relative(ROOT, f)} — нет <meta name="x-mail-group">, пропускаем`);
      continue;
    }
    const previewPath = path.relative(ROOT, f);
    const productionPath = productionMap.get(f) || previewPath; // если SVG не было, prod = preview
    const downloadName = path.basename(previewPath); // имя файла без " production"
    const title = meta.title || meta._docTitle || path.basename(f, '.html');
    navEntries.push({
      group: meta.group,
      groupOrder: meta['group-order'] !== undefined ? parseInt(meta['group-order'], 10) : undefined,
      title,
      date: meta.date,
      order: meta.order !== undefined ? parseInt(meta.order, 10) : undefined,
      previewPath,
      productionPath,
      downloadName
    });
  }
  console.log(`  Писем: ${navEntries.length}`);

  // 3. Метаданные компонентов → components nav
  const componentFiles = findComponentHTMLs();
  const componentEntries = [];
  for (const f of componentFiles) {
    const html = fs.readFileSync(f, 'utf8');
    const meta = extractComponentMeta(html);
    const previewPath = path.relative(ROOT, f);
    const title = meta.name || path.basename(f, '.html');
    componentEntries.push({
      title,
      order: meta.order !== undefined ? parseInt(meta.order, 10) : undefined,
      previewPath,
      downloadName: path.basename(previewPath)
    });
  }
  console.log(`  Компонентов: ${componentEntries.length}`);

  const navHtml = buildNavHtml(navEntries);
  const componentsNavHtml = buildComponentsNavHtml(componentEntries);
  const changed = updateIndex(navHtml, componentsNavHtml);
  console.log(`  index.html: ${changed ? 'обновлён' : 'без изменений'}`);
  console.log('└─');

  console.log('\nDone.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
