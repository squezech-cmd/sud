#!/usr/bin/env node
'use strict';

/**
 * Парсер Яндекс.Карт: организации без сайта.
 *
 * Собирает выдачу Яндекс Карт по запросу и городу, оставляет только фирмы,
 * у которых нет своего сайта (соцсети и карточки на агрегаторах сайтом не
 * считаются), пишет CSV и/или JSON.
 *
 * Примеры:
 *   node src/index.js -q "стоматология" -c "Тула"
 *   node src/index.js -q "автосервис" -c "Казань" -n 30 -o avto.csv --json
 *   node src/index.js -q "кафе" --all --no-city-filter
 */

const fs = require('fs');
const path = require('path');
const { collect, ParseError } = require('./parser');
const { toCsv, COLUMNS } = require('./csv');

const USAGE = `
Парсер Яндекс.Карт — организации без сайта

Использование:
  yandex-maps-parser -q <запрос> [options]

Обязательные:
  -q, --query <текст>      что ищем: «стоматология», «автосервис», «кафе»…

Опции:
  -c, --city <город>       город (рекомендуется): «Тула», «Москва»…
  -n, --max-pages <N>      сколько страниц выдачи листать (по умолчанию 10,
                           1 страница = 25 фирм)
  -o, --out <файл>         файл CSV (по умолчанию results.csv)
      --json               дополнительно записать JSON (тот же базовый файл)
      --all                не фильтровать: сохранить всех, колонка «Сайт» покажет,
                           у кого сайт есть (по умолчанию — только без сайта)
      --no-city-filter     не отсекать организации из соседних городов
      --delay <мс>         пауза между страницами (по умолчанию 1500)
      --file <html>        разобрать сохранённую страницу вместо сети
                           (для проверки формата и офлайн-запуска)
  -h, --help               эта справка

Примеры:
  yandex-maps-parser -q стоматология -c Тула
  yandex-maps-parser -q "салон красоты" -c Москва -n 20 -o salons.csv --json
  yandex-maps-parser -q "грузоперевозки" -c Казань --all
`;

function parseArgs(argv) {
  const opts = {
    query: '',
    city: '',
    maxPages: 10,
    out: 'results.csv',
    json: false,
    all: false,
    cityFilter: true,
    delay: 1500,
    file: '',
    help: false,
  };
  const need = (flag, idx) => {
    const v = argv[idx + 1];
    if (v === undefined || v.startsWith('-')) {
      throw new ParseError(`После ${flag} нужно указать значение`, 'args');
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-q': case '--query': opts.query = need(a, i); i++; break;
      case '-c': case '--city': opts.city = need(a, i); i++; break;
      case '-n': case '--max-pages': opts.maxPages = Number(need(a, i)); i++; break;
      case '-o': case '--out': opts.out = need(a, i); i++; break;
      case '--json': opts.json = true; break;
      case '--all': opts.all = true; break;
      case '--no-city-filter': opts.cityFilter = false; break;
      case '--delay': opts.delay = Number(need(a, i)); i++; break;
      case '--file': opts.file = need(a, i); i++; break;
      case '-h': case '--help': opts.help = true; break;
      default:
        throw new ParseError(`Неизвестный аргумент: ${a} (см. --help)`, 'args');
    }
  }
  if (!Number.isFinite(opts.maxPages) || opts.maxPages < 1) {
    throw new ParseError('--max-pages должен быть числом не меньше 1', 'args');
  }
  if (!Number.isFinite(opts.delay) || opts.delay < 0) {
    throw new ParseError('--delay должен быть числом миллисекунд', 'args');
  }
  return opts;
}

function stamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function decorate(rows, opts) {
  const queryLine = [opts.query, opts.city].filter(Boolean).join(', ');
  const at = stamp();
  return rows.map((r) => ({
    ...r,
    phones: r.phones.join(', '),
    city: opts.city || '',
    query: queryLine,
    collectedAt: at,
  }));
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Ошибка: ${err.message}`);
    console.error('Запустите с --help, чтобы увидеть справку.');
    process.exitCode = 1;
    return;
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  if (!opts.query) {
    console.error('Ошибка: укажите запрос, например -q стоматология');
    console.error('Запустите с --help, чтобы увидеть справку.');
    process.exitCode = 1;
    return;
  }

  const what = [opts.query, opts.city].filter(Boolean).join(' · ');
  console.log(`Яндекс Карты: ${what}`);
  console.log(
    opts.all
      ? 'Фильтр: сохраняем всех (колонка «Сайт» покажет, у кого сайт есть)'
      : 'Фильтр: только организации без сайта'
  );
  console.log(`Листаю до ${opts.maxPages} страниц (по 25 фирм), пауза ${opts.delay} мс…\n`);

  let rows;
  let stats;
  try {
    const collectOpts = {
      query: opts.query,
      city: opts.cityFilter ? opts.city : '',
      maxPages: opts.maxPages,
      delayMs: opts.delay,
      log: (s) => console.log(`  ${s}`),
    };
    if (opts.file) {
      const localHtml = fs.readFileSync(path.resolve(opts.file), 'utf8');
      collectOpts.maxPages = 1;
      collectOpts.fetcher = async () => localHtml;
    }
    const result = await collect(collectOpts);
    rows = result.rows;
    stats = result.stats;
  } catch (err) {
    if (err instanceof ParseError) {
      console.error(`\nОшибка: ${err.message}`);
      if (err.code === 'format') {
        console.error('Формат страницы Яндекс.Карт изменился — сообщите об этом.');
      }
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const selected = opts.all ? rows : rows.filter((r) => !r.hasWebsite);
  const outPath = path.resolve(opts.out);
  const jsonPath = outPath.replace(/\.[^.]+$/, '') + '.json';

  fs.writeFileSync(outPath, toCsv(decorate(selected, opts), COLUMNS), 'utf8');
  if (opts.json) {
    fs.writeFileSync(jsonPath, JSON.stringify(decorate(selected, opts), null, 2), 'utf8');
  }

  console.log('');
  console.log(`Страниц прочитано:        ${stats.pages}`);
  console.log(`Организаций собрано:      ${stats.businesses}`);
  console.log(`  без сайта:              ${stats.noWebsite}`);
  console.log(`  с сайтом:               ${stats.withWebsite}`);
  if (stats.otherCity) {
    console.log(`Отсеяно других городов:   ${stats.otherCity}`);
  }
  if (!stats.exhausted && stats.pages >= opts.maxPages) {
    console.log('Выдача не исчерпана — можно увеличить --max-pages.');
  }
  console.log(`Записано строк:           ${selected.length}`);
  console.log(`CSV:  ${outPath}`);
  if (opts.json) console.log(`JSON: ${jsonPath}`);
}

main().catch((err) => {
  console.error(`Непредвиденная ошибка: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
});
