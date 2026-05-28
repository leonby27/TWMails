#!/usr/bin/env node
/**
 * build-prod.js — преобразует все designv2 preview HTML-файлы в production-версии:
 *   - находит inline <svg> с явными width/height
 *   - рендерит каждый в PNG @3x через sharp (density 384)
 *   - сохраняет PNG в img/icon-<хэш>.png (хеш по содержимому, идемпотентно)
 *   - заменяет <svg> на <img src="<BASE_URL>/img/icon-<хэш>.png">
 *   - пишет рядом файл "(designv2 production).html"
 *
 * Использование:
 *   node scripts/build-prod.js          # boevoy build c хостингом на GitHub Pages
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

// Папки/файлы, которые не сканируем
const SKIP_DIRS = new Set(['.git', '.github', 'node_modules', 'img', 'scripts', 'templates']);

function findDesignV2Previews(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findDesignV2Previews(full, results);
    } else if (entry.isFile()
      && entry.name.endsWith('.html')
      && entry.name.includes('(designv2)')
      && !entry.name.includes('(designv2 production)')) {
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
  console.log(`\n→ ${rel}`);
  let html = fs.readFileSync(srcPath, 'utf8');

  // Регекс находит <svg ...>...</svg> блоки. SVG в наших письмах не вложенные,
  // line-by-line безопасно.
  const svgRegex = /<svg\b([^>]*)>([\s\S]*?)<\/svg>/g;
  const matches = [];
  let m;
  while ((m = svgRegex.exec(html)) !== null) {
    matches.push({ full: m[0], attrs: m[1], index: m.index });
  }
  if (matches.length === 0) {
    console.log('  (нет inline SVG, ничего не делаем)');
    return;
  }
  console.log(`  найдено ${matches.length} inline SVG`);

  fs.mkdirSync(IMG_DIR, { recursive: true });

  // обрабатываем с конца к началу, чтобы индексы не сдвигались при replace
  matches.reverse();
  let generated = 0;
  let reused = 0;
  for (const match of matches) {
    const wMatch = match.attrs.match(/\bwidth=["'](\d+)["']/);
    const hMatch = match.attrs.match(/\bheight=["'](\d+)["']/);
    if (!wMatch || !hMatch) {
      console.warn(`  ⚠ SVG без width/height, пропускаем (attrs: ${match.attrs.slice(0, 80)}...)`);
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
  console.log(`  PNG: сгенерировано ${generated}, переиспользовано ${reused}`);

  // Имя выходного файла: "X (designv2).html" → "X (designv2 production).html"
  const outName = path.basename(srcPath).replace('(designv2)', '(designv2 production)');
  const outPath = path.join(path.dirname(srcPath), outName);
  fs.writeFileSync(outPath, html);
  console.log(`  ✓ ${path.relative(ROOT, outPath)}`);
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

(async () => {
  const files = findDesignV2Previews(ROOT);
  console.log(`Найдено ${files.length} designv2 preview-файлов`);
  console.log(`Базовый URL для PNG: ${BASE_URL}/${IMG_REL}/`);
  const manifest = new Set();
  for (const f of files) {
    await processFile(f, manifest);
  }
  cleanupOrphans(manifest);
  console.log('\nDone.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
