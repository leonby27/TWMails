#!/usr/bin/env node
/**
 * build-prod.js — для всех preview-HTML с inline <svg> генерит production-версию:
 *   - находит inline <svg> с явными width/height
 *   - рендерит каждый в PNG @3x через sharp (density 384)
 *   - сохраняет PNG в img/icon-<хэш>.png (хеш по содержимому, идемпотентно)
 *   - заменяет <svg> на <img src="<BASE_URL>/img/icon-<хэш>.png">
 *   - пишет рядом файл с суффиксом " production" (перед .html)
 *
 * Сканирует все .html в репо, пропуская:
 *   - корневой index.html (viewer)
 *   - файлы, у которых в имени уже есть " production"
 *   - templates/, scripts/, .github/, node_modules/, img/, .git/
 *
 * Использование:
 *   node scripts/build-prod.js
 *   PROD_BASE_URL=https://cdn.example.com node scripts/build-prod.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const IMG_DIR = path.join(ROOT, 'img');
const IMG_REL = 'img';
const BASE_URL = (process.env.PROD_BASE_URL || 'https://leonby27.github.io/TWMails').replace(/\/+$/, '');

const SKIP_DIRS = new Set(['.git', '.github', 'node_modules', 'img', 'scripts', 'templates']);
const PRODUCTION_SUFFIX = ' production';

function findPreviewHTMLs(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findPreviewHTMLs(full, results);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      // Skip viewer index.html (на корне)
      if (full === path.join(ROOT, 'index.html')) continue;
      // Skip уже production-файлы
      if (entry.name.includes(PRODUCTION_SUFFIX + '.html')) continue;
      results.push(full);
    }
  }
  return results;
}

function hashContent(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
}

async function rasterize(svgString, displayW, displayH, outPath) {
  const scale = 3; // retina @3x
  await sharp(Buffer.from(svgString), { density: 384 })
    .resize(displayW * scale, displayH * scale)
    .png({ compressionLevel: 9 })
    .toFile(outPath);
}

async function processFile(srcPath, manifest) {
  const rel = path.relative(ROOT, srcPath);
  let html = fs.readFileSync(srcPath, 'utf8');

  const svgRegex = /<svg\b([^>]*)>([\s\S]*?)<\/svg>/g;
  const matches = [];
  let m;
  while ((m = svgRegex.exec(html)) !== null) {
    matches.push({ full: m[0], attrs: m[1], index: m.index });
  }
  if (matches.length === 0) {
    return false; // не было SVG, production-файл не нужен
  }
  console.log(`\n→ ${rel}`);
  console.log(`  найдено ${matches.length} inline SVG`);

  fs.mkdirSync(IMG_DIR, { recursive: true });

  matches.reverse();
  let generated = 0;
  let reused = 0;
  let skipped = 0;
  for (const match of matches) {
    const wMatch = match.attrs.match(/\bwidth=["'](\d+)["']/);
    const hMatch = match.attrs.match(/\bheight=["'](\d+)["']/);
    if (!wMatch || !hMatch) {
      console.warn(`  ⚠ SVG без width/height, пропускаем`);
      skipped++;
      continue;
    }
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
  console.log(`  PNG: сгенерировано ${generated}, переиспользовано ${reused}${skipped ? ', пропущено ' + skipped : ''}`);

  // Имя выходного файла: "X.html" → "X production.html"
  // (если уже есть скобки в имени, suffix просто добавляется в конец)
  const dir = path.dirname(srcPath);
  const baseName = path.basename(srcPath, '.html');
  const outName = `${baseName}${PRODUCTION_SUFFIX}.html`;
  const outPath = path.join(dir, outName);
  fs.writeFileSync(outPath, html);
  console.log(`  ✓ ${path.relative(ROOT, outPath)}`);
  return true;
}

function cleanupOrphans(referenced, allProductionFiles) {
  // Удалить неиспользуемые PNG
  if (fs.existsSync(IMG_DIR)) {
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

  // Удалить устаревший production-файл со старым именованием
  // (designv2 production) → теперь (designv2) production
  const legacyDesignv2 = path.join(ROOT, 'Возврат на годовой тариф/Верните годовой тариф (designv2 production).html');
  if (fs.existsSync(legacyDesignv2)) {
    fs.unlinkSync(legacyDesignv2);
    console.log(`🧹 удалён устаревший production-файл: Верните годовой тариф (designv2 production).html`);
  }
}

(async () => {
  const files = findPreviewHTMLs(ROOT);
  console.log(`Найдено ${files.length} preview-HTML-файлов`);
  console.log(`Базовый URL для PNG: ${BASE_URL}/${IMG_REL}/`);
  const manifest = new Set();
  const productionFiles = [];
  for (const f of files) {
    const created = await processFile(f, manifest);
    if (created) productionFiles.push(f);
  }
  cleanupOrphans(manifest, productionFiles);
  console.log(`\nDone. Production-файлов: ${productionFiles.length}.`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
