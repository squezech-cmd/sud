'use strict';

/**
 * Тесты парсера: разбор состояния страницы, фильтр «без сайта», CSV.
 * Запуск: npm test  (node test/run-tests.js)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  extractPage,
  normalizeItem,
  isRealWebsite,
  findWebsite,
  extractPhones,
} = require('../src/parser');
const { toCsv, COLUMNS } = require('../src/csv');

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

const html = fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'yandex_search.html'),
  'utf8'
);

console.log('extractPage');
const { items } = extractPage(html);
ok('находит stack[0].results.items', () => {
  assert.strictEqual(Array.isArray(items), true);
  assert.strictEqual(items.length, 6);
});
ok('формат страницы без state — честная ошибка', () => {
  assert.throws(() => extractPage('<html><body>нет данных</body></html>'), /Состояние страницы/);
});

console.log('классификация ссылок');
ok('https://example.ru — сайт', () => assert.strictEqual(isRealWebsite('https://example.ru'), true));
ok('example.ru без схемы — сайт', () => assert.strictEqual(isRealWebsite('example.ru'), true));
ok('//example.ru — сайт', () => assert.strictEqual(isRealWebsite('//example.ru'), true));
ok('vk.com — не сайт', () => assert.strictEqual(isRealWebsite('https://vk.com/club1'), false));
ok('t.me — не сайт', () => assert.strictEqual(isRealWebsite('https://t.me/x'), false));
ok('2gis.ru — не сайт', () => assert.strictEqual(isRealWebsite('https://2gis.ru/xxx'), false));
ok('yandex.ru — не сайт', () => assert.strictEqual(isRealWebsite('https://yandex.ru/maps/org/1/'), false));
ok('mailto — не сайт', () => assert.strictEqual(isRealWebsite('mailto:a@b.ru'), false));
ok('пусто — не сайт', () => assert.strictEqual(isRealWebsite(''), false));

console.log('findWebsite');
ok('firmа с urls: https — сайт найден', () => {
  assert.strictEqual(findWebsite({ urls: ['https://a.ru'] }), 'https://a.ru');
});
ok('только соцсети — сайта нет', () => {
  assert.strictEqual(
    findWebsite({ urls: [], socialLinks: [{ href: 'https://vk.com/x' }] }),
    ''
  );
});
ok('сайт в businessLinks — найден', () => {
  assert.strictEqual(
    findWebsite({ businessLinks: [{ href: 'https://site.ru' }] }),
    'https://site.ru'
  );
});

console.log('extractPhones');
ok('нормальные телефоны, whatsapp дубль убран', () => {
  const phones = extractPhones({
    phones: [
      { type: 'phone', value: '+79991234567' },
      { type: 'whatsapp', value: '+79991234567' },
      { type: 'phone', number: '+7 927 000-11-22' },
    ],
  });
  assert.deepStrictEqual(phones, ['+79991234567', '+7 927 000-11-22']);
});

console.log('normalizeItem');
const biz = (id) => items.find((x) => x.id === id);
ok('подборка пропускается', () => {
  assert.strictEqual(normalizeItem(items[0]).skip, 'type');
});
ok('фирма с сайтом — hasWebsite=true', () => {
  const r = normalizeItem(biz('1300000000111'), { city: 'Тула' });
  assert.strictEqual(r.row.hasWebsite, true);
  assert.strictEqual(r.row.website, 'https://zdorovye-zuby.ru');
  assert.strictEqual(r.row.verified, 'да');
  assert.strictEqual(r.row.rating, 4.7);
  assert.strictEqual(r.row.reviews, 120);
});
ok('фирма только с соцсетями — hasWebsite=false', () => {
  const r = normalizeItem(biz('1300000000222'), { city: 'Тула' });
  assert.strictEqual(r.row.hasWebsite, false);
  assert.strictEqual(r.row.website, '');
  assert.strictEqual(r.row.chain, 'Стома-Тул');
  assert.strictEqual(r.row.verified, 'нет');
  assert.strictEqual(r.row.reviews, 51);
});
ok('чужой город отсекается фильтром города', () => {
  const r = normalizeItem(biz('1300000000333'), { city: 'Тула' });
  assert.strictEqual(r.skip, 'other-city');
});
ok('без фильтра города — чужой город проходит', () => {
  const r = normalizeItem(biz('1300000000333'), { city: '' });
  assert.strictEqual(r.row.hasWebsite, true);
});
ok('url без схемы — сайт засчитан', () => {
  const r = normalizeItem(biz('1300000000444'), { city: 'Тула' });
  assert.strictEqual(r.row.hasWebsite, true);
  assert.strictEqual(r.row.website, 'https://dentservis-tula.ru');
});
ok('transport пропускается', () => {
  const r = normalizeItem(items[5]);
  assert.strictEqual(r.skip, 'type');
});
ok('карточка собирается в ссылку', () => {
  const r = normalizeItem(biz('1300000000222'), { city: 'Тула' });
  assert.strictEqual(
    r.row.cardUrl,
    'https://yandex.ru/maps/org/stomatologiya-na-plehanova/1300000000222/'
  );
});

console.log('CSV');
ok('BOM + разделитель ; + кавычки экранируются', () => {
  const csv = toCsv(
    [{ name: 'ООО «А;Б»', phones: '+7 900 123-45-67, +7 900 765-43-21' }],
    COLUMNS
  );
  assert.strictEqual(csv.charCodeAt(0), 0xfeff, 'должен начинаться с BOM');
  assert.ok(csv.includes('"ООО «А;Б»"'), 'ячейка с ; в кавычках');
  assert.ok(csv.split('\r\n')[0].includes('Название;Адрес;Телефоны'));
});

console.log('фильтр «без сайта» на всей странице');
ok('из фикстуры: в Туле 3 фирмы, без сайта — 1', () => {
  const rows = items
    .map((it) => normalizeItem(it, { city: 'Тула' }))
    .filter((r) => r.row)
    .map((r) => r.row);
  const noSite = rows.filter((r) => !r.hasWebsite);
  assert.strictEqual(rows.length, 3, 'в Туле три фирмы');
  assert.strictEqual(noSite.length, 1, 'без сайта одна');
  assert.strictEqual(noSite[0].name, 'Стоматология на Плеханова');
  // фирма с сайтом без схемы (dentservis-tula.ru) в «без сайта» не попадает
  const withSite = rows.filter((r) => r.hasWebsite).map((r) => r.name);
  assert.ok(withSite.includes('ДентСервис на Заречке'));
  assert.ok(withSite.includes('Клиника «Здоровые зубы»'));
});

if (process.exitCode) {
  console.log('\nЕСТЬ ОШИБКИ');
} else {
  console.log(`\nВсе проверки пройдены: ${passed}`);
}
