/* Аудит интерфейса: в экранах нет дублей и «мёртвых» ссылок.
 *
 * Правило, которое проверяется (по нему же написан экран):
 *     одно действие — один орган управления;
 *     одно состояние — одно место на экране.
 *
 * Проверяются все страницы gui/: уникальность id, отсутствие двух кнопок с
 * одинаковой надписью и одинаковой ролью, существование всех id, на которые
 * ссылается скрипт страницы, отсутствие заведомо мёртвых ветвей кода.
 *
 * Запуск:  NODE_PATH=/tmp/harness/node_modules node gui/tests/ui.audit.test.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const GUI = path.join(__dirname, '..');
const PAGES = ['main.html', 'index.html'];

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra: ok ? '' : (extra || '') });
const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** id, которые скрипт создаёт во время работы (шаблоны вида id="mc-${…}"). */
function dynamicPrefixes(src) {
  const out = new Set();
  const re = /id="([A-Za-z0-9_-]*)\$\{/g;
  let m;
  while ((m = re.exec(src))) out.add(m[1]);
  return [...out];
}

for (const page of PAGES) {
  const html = fs.readFileSync(path.join(GUI, page), 'utf8');
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const scripts = [...doc.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'));
  const js = scripts.map((f) => fs.readFileSync(path.join(GUI, f.replace(/^\.\//, '')), 'utf8')).join('\n');

  // 1. Уникальность id в разметке
  const ids = [...doc.querySelectorAll('[id]')].map((el) => el.id);
  const dup = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  check(page + ': все id уникальны', dup.length === 0, dup.join(', '));
  check(page + ': нет пустых id', ids.every((id) => id.trim() !== ''), ids.filter((id) => !id.trim()).length + ' шт.');

  // 2. Никакие два органа управления не подписаны одинаково **в пределах
  //    одной вкладки**: на пульте вкладки видны по одной, поэтому одинаковые
  //    подписи в разных вкладках допустимы, а в одной — это дубль.
  const groupOf = (el) => {
    const v = el.closest('.view');
    return v ? v.id : 'экран';
  };
  const controls = [...doc.querySelectorAll('button, a[href], [role="button"]')]
    .filter((el) => norm(el.textContent) !== '');
  const seen = new Map();
  const dupNames = [];
  for (const el of controls) {
    const key = groupOf(el) + ' :: ' + norm(el.textContent);
    if (seen.has(key)) dupNames.push(key);
    seen.set(key, true);
  }
  check(page + ': нет двух органов управления с одинаковой надписью в одной вкладке',
    dupNames.length === 0, dupNames.map((n) => '«' + n + '»').join(', '));

  // 3. Одинаковые aria-label и data-атрибуты-переключатели
  for (const attr of ['aria-label', 'data-key']) {
    const vals = [...doc.querySelectorAll('[' + attr + ']')]
      .map((el) => el.getAttribute(attr)).filter((v) => v !== null && v !== '');
    const d = [...new Set(vals.filter((v, i) => vals.indexOf(v) !== i))];
    // цифровые клавиши клавиатуры набираются разметкой из скрипта, поэтому
    // повторов быть не должно ни по одному из этих атрибутов
    check(page + ': нет повторов ' + attr, d.length === 0, d.join(', '));
  }

  // 4. Скрипт не ссылается на несуществующие id
  const prefixes = dynamicPrefixes(js);
  const refs = new Set();
  let m;
  const re = /\$\('([A-Za-z0-9_-]+)'\)|getElementById\('([A-Za-z0-9_-]+)'\)/g;
  while ((m = re.exec(js))) refs.add(m[1] || m[2]);
  const missing = [...refs].filter((id) => !ids.includes(id) && !prefixes.some((p) => id.startsWith(p)));
  check(page + ': все id из скрипта существуют', missing.length === 0, missing.join(', '));

  // 5. Правило «одно действие — один орган управления» на примере сброса ввода.
  //    Клавиатура рисуется скриптом, поэтому набор клавиш проверяем по исходнику.
  if (page === 'main.html') {
    const keypadLine = (js.match(/const KEYPAD = \[([^\]]*)\]/) || [, ''])[1];
    const resets = (keypadLine.match(/'СБРОС'/g) || []).length;
    check('main.html: сброс PIN — ровно одна клавиша клавиатуры', resets === 1, 'найдено: ' + resets);
    check('main.html: в разметке нет второй кнопки сброса', !/>\s*Сброс\s*</.test(html));
    check('main.html: кнопок отсека ровно одна', doc.querySelectorAll('.sc-lock-buttons button').length === 1);
    check('main.html: открытие/закрытие — одна кнопка с меняющейся надписью',
      /openBtn\.textContent = lv\.open \? 'Закрыть отсек' : 'Открыть отсек'/.test(js));
  }
}

// 6. Гигиена кода: мёртвые ветви и заглушки
for (const f of ['main.js', 'app.js', 'console.js', 'console-core.js']) {
  const src = fs.readFileSync(path.join(GUI, f), 'utf8');
  const dead = [/&&\s*false\b/, /if\s*\(\s*false\s*\)/, /\/\*\s*TODO\s*\*\//].filter((re) => re.test(src));
  check(f + ': нет мёртвых ветвей кода (&& false, if (false), TODO)', dead.length === 0,
    dead.map((re) => re.source).join(', '));
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log((r.ok ? '  ok   ' : '  FAIL ') + r.name + (r.extra ? '\n        ' + r.extra : ''));
console.log('\nИТОГО аудит интерфейса: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
