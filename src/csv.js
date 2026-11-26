'use strict';

/** Экранирование ячейки CSV (разделитель «;», кавычки — двойные). */
function csvCell(v) {
  if (v == null) return '';
  const s = Array.isArray(v) ? v.join(', ') : String(v);
  if (/[",;\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** CSV с BOM — чтобы Excel открывал кириллицу двойным щелчком. */
function toCsv(rows, columns) {
  const lines = [columns.map((c) => csvCell(c.header)).join(';')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvCell(row[c.key])).join(';'));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

const COLUMNS = [
  { key: 'name', header: 'Название' },
  { key: 'address', header: 'Адрес' },
  { key: 'phones', header: 'Телефоны' },
  { key: 'rating', header: 'Оценка' },
  { key: 'reviews', header: 'Отзывов' },
  { key: 'photos', header: 'Фото' },
  { key: 'categories', header: 'Категории' },
  { key: 'hours', header: 'Часы работы' },
  { key: 'chain', header: 'Сеть' },
  { key: 'verified', header: 'Карточка подтверждена' },
  { key: 'website', header: 'Сайт' },
  { key: 'lat', header: 'Широта' },
  { key: 'lon', header: 'Долгота' },
  { key: 'cardUrl', header: 'Ссылка на карточку' },
  { key: 'city', header: 'Город' },
  { key: 'query', header: 'Запрос' },
  { key: 'collectedAt', header: 'Дата сбора' },
];

module.exports = { csvCell, toCsv, COLUMNS };
