'use strict';

/**
 * Парсер Яндекс.Карт — извлечение организаций из серверного состояния страницы.
 *
 * Яндекс отдаёт результаты поиска «на сервере»: данные лежат в самом большом
 * теге <script type="application/json">, путь к списку фирм — stack[0].results.items
 * (25 организаций на странице). Ни ключей API, ни браузера не нужно.
 *
 * Источники проверенной информации о формате (октябрь–май 2026, независимые
 * открытые проекты): krein15/maps-parser (docs/recon.md, mapsparser/sources/yandex.py)
 * и volk6022/Atomic-Scraper-Service (src/actions/yandex_maps.py).
 */

const SITE = 'https://yandex.ru/maps';
const PAGE_SIZE = 25;

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
};

class ParseError extends Error {
  constructor(message, code = 'parse') {
    super(message);
    this.code = code;
    this.name = 'ParseError';
  }
}

// Хосты, которые НЕ являются сайтом фирмы: соцсети, мессенджеры,
// карточки на агрегаторах и собственные домены Яндекса.
const NON_SITE_HOSTS = new Set([
  'vk.com', 'vk.ru', 'm.vk.com',
  't.me', 'telegram.me',
  'instagram.com',
  'facebook.com', 'fb.com',
  'ok.ru', 'odnoklassniki.ru',
  'youtube.com', 'youtu.be',
  'twitter.com', 'x.com',
  'whatsapp.com', 'wa.me',
  'viber.com',
  'tiktok.com', 'linkedin.com', 'pinterest.com', 'pinterest.ru',
  'rutube.ru',
  'dzen.ru',
  'my.mail.ru', 'mail.ru',
  '2gis.ru',
]);

// Типы телефонов, которые не являются голосовым номером фирмы.
const NON_VOICE_PHONE_TYPES = new Set([
  'whatsapp', 'telegram', 'viber', 'signal', 'skype', 'email', 'social',
]);

function hostOf(url) {
  try {
    let u = String(url).trim();
    if (u.startsWith('//')) u = 'https:' + u;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u; // «site.ru/path» без схемы
    return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isYandexHost(h) {
  return (
    h === 'yandex.ru' || h.endsWith('.yandex.ru') ||
    h === 'yandex.com' || h.endsWith('.yandex.com') ||
    h === 'ya.cc'
  );
}

/** Правда ли, что url — самостоятельный сайт фирмы (а не соцсеть/карточка). */
function isRealWebsite(url) {
  const h = hostOf(url);
  if (!h) return false;
  if (NON_SITE_HOSTS.has(h)) return false;
  if (isYandexHost(h)) return false;
  return true;
}

function normalizeUrl(url) {
  let s = String(url).trim();
  if (s.startsWith('//')) s = 'https:' + s;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
  return s;
}

/** Все ссылки, которые фирма могла указать как «сайт» (в разных полях карточки). */
function candidateUrls(item) {
  const out = [];
  const push = (v) => {
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  };
  if (Array.isArray(item.urls)) item.urls.forEach(push);
  if (Array.isArray(item.websites)) item.websites.forEach(push);
  push(item.website);
  push(item.site);
  for (const key of ['socialLinks', 'businessLinks']) {
    const arr = item[key];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (typeof entry === 'string') push(entry);
      else if (entry && typeof entry === 'object') {
        push(entry.href);
        push(entry.url);
      }
    }
  }
  return out;
}

/** Сайт фирмы или '' если его нет (соцсети и карточки на агрегаторах не считаются). */
function findWebsite(item) {
  for (const raw of candidateUrls(item)) {
    if (isRealWebsite(raw)) return normalizeUrl(raw);
  }
  return '';
}

function extractPhones(item) {
  const res = [];
  const add = (v) => {
    const s = String(v || '').trim();
    if (s && !res.includes(s)) res.push(s);
  };
  for (const p of item.phones || []) {
    if (!p) continue;
    if (typeof p === 'string') { add(p); continue; }
    const t = String(p.type || '').toLowerCase();
    if (NON_VOICE_PHONE_TYPES.has(t)) continue;
    add(p.value || p.number || p.formatted || '');
  }
  return res;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : '';
}

/** Адрес содержит название города («ё» → «е», без учёта регистра)? */
function matchCity(address, city) {
  const a = String(address).toLowerCase().replace(/ё/g, 'е');
  const c = String(city).toLowerCase().trim().replace(/ё/g, 'е');
  return a.includes(c);
}

/** Самый большой <script> с валидным JSON; приоритет — тот, где есть stack[].results.items. */
function extractPage(html) {
  if (typeof html !== 'string' || !html) {
    throw new ParseError('Пустой ответ страницы', 'parse');
  }
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  let largest = null;
  let largestLen = -1;
  while ((m = re.exec(html)) !== null) {
    const text = m[1].trim();
    if (text.length < 50) continue;
    let obj = null;
    try {
      obj = JSON.parse(text);
    } catch {
      continue; // обычные JS-скрипты — не JSON
    }
    const items = pickItems(obj);
    if (items) return { items, state: obj };
    if (text.length > largestLen) {
      largest = obj;
      largestLen = text.length;
    }
  }
  if (largest) {
    const items = pickItems(largest);
    if (items) return { items, state: largest };
  }
  throw new ParseError(
    'Состояние страницы не найдено — похоже, формат Яндекс.Карт изменился',
    'format'
  );
}

function pickItems(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj.stack)) {
    for (const frame of obj.stack) {
      if (
        frame && typeof frame === 'object' &&
        frame.results && Array.isArray(frame.results.items)
      ) {
        return frame.results.items;
      }
    }
  }
  if (obj.results && Array.isArray(obj.results.items)) return obj.results.items;
  return null;
}

/**
 * Одна организация из выдачи.
 * Возвращает { row } или { skip: причина }.
 */
function normalizeItem(item, opts = {}) {
  if (!item || typeof item !== 'object') return { skip: 'not-object' };
  if (item.type !== 'business') return { skip: 'type' }; // подборки, транспорт
  const name = String(item.title || '').trim();
  const id = item.id != null ? String(item.id) : '';
  if (!name || !id) return { skip: 'incomplete' };

  const address = String(item.fullAddress || item.address || '').trim();
  const city = String(opts.city || '').trim();
  if (city && address && !matchCity(address, city)) return { skip: 'other-city' };

  const coords = Array.isArray(item.coordinates) ? item.coordinates : [];
  const rd = item.ratingData || {};
  const props = item.businessProperties || {};
  const categories = (Array.isArray(item.categories) ? item.categories : [])
    .map((c) => (c && c.name ? String(c.name) : ''))
    .filter(Boolean)
    .join(', ');
  const photos =
    item.photos && typeof item.photos === 'object' ? num(item.photos.count) : '';
  const website = findWebsite(item);
  const seoname = String(item.seoname || '').trim() || 'org';

  return {
    row: {
      id,
      name,
      address,
      phones: extractPhones(item),
      website,
      hasWebsite: !!website,
      rating: rd.ratingValue != null ? num(rd.ratingValue) : '',
      reviews:
        rd.reviewCount != null
          ? num(rd.reviewCount)
          : rd.ratingCount != null
            ? num(rd.ratingCount)
            : '',
      categories,
      hours: String(item.workingTimeText || '').trim(),
      chain: item.chain && item.chain.name ? String(item.chain.name).trim() : '',
      verified:
        props.has_verified_owner === true
          ? 'да'
          : props.has_verified_owner === false
            ? 'нет'
            : '',
      photos: photos === '' ? '' : photos,
      lat: num(coords[1]),
      lon: num(coords[0]),
      cardUrl: `${SITE}/org/${encodeURIComponent(seoname)}/${id}/`,
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GET страницы с повторами. Капча/блокировка — честная ошибка, без обхода. */
async function fetchHtml(url, { retries = 3, timeoutMs = 30000 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await sleep(attempt === 1 ? 1500 : 4000);
    let res;
    try {
      res = await fetch(url, {
        headers: HEADERS,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastErr = new ParseError(
        'Сеть: ' + ((err && err.message) || err),
        'network'
      );
      continue;
    }
    const status = res.status;
    if (status >= 200 && status < 300) {
      const html = await res.text();
      if (/smartcaptcha|showcaptcha|captcha-challenge/i.test(html)) {
        throw new ParseError(
          'Яндекс показал капчу. Сделайте паузу (несколько минут) и запустите ' +
            'повторите позже — обходить защиту программа не будет.',
          'captcha'
        );
      }
      return html;
    }
    if (status === 404) throw new ParseError('Страница не найдена (404)', 'http');
    if (status >= 500 || status === 429 || status === 403) {
      lastErr = new ParseError(
        `Яндекс ответил HTTP ${status} — попробуем ещё раз`,
        'http'
      );
      continue;
    }
    throw new ParseError(`Яндекс ответил HTTP ${status}`, 'http');
  }
  throw lastErr || new ParseError('Не удалось получить страницу', 'network');
}

/**
 * Листание выдачи: собирает организации, пока приходят новые.
 * Возвращает { rows, stats }.
 */
async function collect({
  query = '',
  city = '',
  maxPages = 10,
  delayMs = 1500,
  log = () => {},
  fetcher = fetchHtml,
} = {}) {
  const text = [query, city]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(' ');
  if (!text) throw new ParseError('Укажите запрос', 'args');

  const byId = new Map();
  const stats = {
    pages: 0,
    businesses: 0,
    noWebsite: 0,
    withWebsite: 0,
    otherCity: 0,
    exhausted: false,
  };

  for (let page = 1; page <= maxPages; page++) {
    let url = `${SITE}/?text=${encodeURIComponent(text)}`;
    if (page > 1) url += `&page=${page}`;
    const html = await fetcher(url, { page });
    const { items } = extractPage(html);
    stats.pages = page;

    let added = 0;
    for (const item of items) {
      const r = normalizeItem(item, { city });
      if (r.skip === 'other-city') {
        stats.otherCity++;
        continue;
      }
      if (r.skip) continue;
      if (!byId.has(r.row.id)) {
        byId.set(r.row.id, r.row);
        added++;
      }
    }

    const rows = [...byId.values()];
    stats.businesses = rows.length;
    stats.noWebsite = rows.filter((r) => !r.hasWebsite).length;
    stats.withWebsite = rows.length - stats.noWebsite;
    log(
      `страница ${page}: +${added}, всего ${stats.businesses}` +
        ` (без сайта: ${stats.noWebsite})`
    );

    if (added === 0) {
      stats.exhausted = true; // выдача кончилась — новых организаций нет
      break;
    }
    if (page < maxPages) {
      await sleep(delayMs + Math.floor(Math.random() * 700));
    }
  }

  return { rows: [...byId.values()], stats };
}

module.exports = {
  SITE,
  PAGE_SIZE,
  ParseError,
  extractPage,
  normalizeItem,
  findWebsite,
  isRealWebsite,
  extractPhones,
  matchCity,
  fetchHtml,
  collect,
  sleep,
};
