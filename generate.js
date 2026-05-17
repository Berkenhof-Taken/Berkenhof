// Berkenhof – Automatische weeklijst generator met Notion API
// Draait dagelijks via GitHub Actions
//
// NIEUW v2 (2026-05-17):
//   • Feedback-loop op maandag:
//       - Niet-afgevinkte WEKELIJKSE taken → Gemist=true (volgende keer rood/HOOFDLETTERS)
//       - Niet-afgevinkte taken met frequentie < 1x/week → Startdatum +7 dagen
//         (taak verschijnt deze nieuwe week opnieuw, daarna terug normale cyclus)
//       - Dagelijks / 2x/week / elke weekdag → geen aanpassing
//   • Gemist-vlag wordt elke maandag eerst opgeruimd vóór nieuwe markeringen.

const fs = require('fs');

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DATABASE_ID  = '3bcd33c3-2acc-82b4-850a-01c2b99e8df0';

// Notion rate limit: max 3 req/sec. We hanteren 350ms tussen calls.
const RATE_DELAY_MS = 350;
const wait = ms => new Promise(r => setTimeout(r, ms));

// ── ISO weeknummer ───────────────────────────────────────────────
function getISOWeek(d) {
  const jan4 = new Date(d.getFullYear(), 0, 4);
  const dow  = jan4.getDay() || 7;
  const w1   = new Date(jan4); w1.setDate(jan4.getDate() + 1 - dow);
  const diff = Math.floor((d - w1) / 86400000);
  if (diff < 0) return getISOWeek(new Date(d.getFullYear()-1, 11, 28));
  return Math.floor(diff/7) + 1;
}

// ── Feestdagen ───────────────────────────────────────────────────
const FEESTDAGEN = new Set([
  '2026-05-25','2026-07-21','2026-08-15',
  '2026-11-01','2026-11-11','2026-12-25',
  '2027-01-01','2027-03-29','2027-05-01','2027-05-06',
  '2027-05-17','2027-07-21','2027-08-15','2027-11-01',
  '2027-11-11','2027-12-25'
]);

function dateStr(d) { return d.toISOString().slice(0,10); }
function isHoliday(d) { return FEESTDAGEN.has(dateStr(d)); }

// ── Is taak actief in een gegeven ISO-week? ──────────────────────
function isActief(freq, start, targetWeek) {
  if (!freq) return false;
  if (['wekelijks','dagelijks','2x/week','elke weekdag'].includes(freq)) return true;
  if (!start) return false;
  const sw = getISOWeek(new Date(start));
  const d  = targetWeek - sw;
  if (d < 0) return false;
  const fw = {'2-wekelijks':2,'3-wekelijks':3,'4-wekelijks':4,'6-wekelijks':6,
              '8-wekelijks':8,'12-wekelijks':12,'16-wekelijks':16,'52-wekelijks':52}[freq];
  return fw ? d % fw === 0 : false;
}

// ── Huidige werkweek berekenen ───────────────────────────────────
const today = new Date(); today.setHours(0,0,0,0);
// Reset-dag: zondagnamiddag (cron op zo 14u) of maandag (manuele trigger)
const IS_RESET_DAY = today.getDay() === 0 || today.getDay() === 1;
const dow   = today.getDay();
let ma;
if (dow === 0) { ma = new Date(today); ma.setDate(today.getDate() + 1); }
else if (dow === 6) { ma = new Date(today); ma.setDate(today.getDate() + 2); }
else { ma = new Date(today); ma.setDate(today.getDate() - (dow - 1)); }
const week = getISOWeek(ma);

// Vorige werkweek (voor feedback-loop op maandag)
const prevMa = new Date(ma); prevMa.setDate(ma.getDate() - 7);
const prevWeek = getISOWeek(prevMa);

const MAANDEN = ['','januari','februari','maart','april','mei','juni',
                 'juli','augustus','september','oktober','november','december'];
function fmt(d) { return `${d.getDate()} ${MAANDEN[d.getMonth()+1]}`; }

const DAGEN = [
  {k:'ma', d: new Date(ma)},
  {k:'di', d: new Date(ma.getTime()+86400000)},
  {k:'wo', d: new Date(ma.getTime()+172800000)},
  {k:'do', d: new Date(ma.getTime()+259200000)},
  {k:'vr', d: new Date(ma.getTime()+345600000)},
].map(dag => ({...dag, l: `${['Maandag','Dinsdag','Woensdag','Donderdag','Vrijdag'][['ma','di','wo','do','vr'].indexOf(dag.k)]} ${fmt(dag.d)}`}));

const weekLabel = `${fmt(ma)} – ${fmt(new Date(ma.getTime()+345600000))} ${ma.getFullYear()}`;

// ── Kleuren per persoon ──────────────────────────────────────────
const KLEUREN = {
  'Rita':    {h:'#A0522D', d:'#F0B27A', dl:'#D4A843'},
  'Wioleta': {h:'#4A235A', d:'#C39BD3', dl:'#9B59B6'},
  'Jon':     {h:'#1A5276', d:'#5DADE2', dl:'#2E86C1'},
  'Karin':   {h:'#1E8449', d:'#52BE80', dl:'#27AE60'},
  'Loïc':    {h:'#784212', d:'#F0B27A', dl:'#CA6F1E'},
};
const DISPLAY = {
  'Rita':'Rita','Wioleta':'Wioletta','Jon':'Jon','Karin':'Karin','Loïc':'Lo&#239;c'
};
const VOLGORDE = ['Rita','Wioleta','Jon','Karin','Loïc'];

// ── Notion API helper ────────────────────────────────────────────
async function notionPatch(pageId, properties) {
  const r = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ properties })
  });
  if (!r.ok) {
    const e = await r.text();
    throw new Error(`Notion API fout ${r.status}: ${e}`);
  }
}

// ── Notion API query ─────────────────────────────────────────────
async function queryNotion() {
  const results = [];
  let cursor = null;
  do {
    const body = {
      filter: { property: 'Status', select: { equals: 'actief' } },
      page_size: 100
    };
    if (cursor) body.start_cursor = cursor;

    const resp = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Notion API fout ${resp.status}: ${err}`);
    }

    const data = await resp.json();
    results.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);

  console.log(`${results.length} taken opgehaald uit Notion`);
  return results;
}

// ── NIEUW: feedback-loop op maandag ──────────────────────────────
const FREQ_MINDER_DAN_WEKELIJKS = new Set([
  '2-wekelijks','3-wekelijks','4-wekelijks','6-wekelijks',
  '8-wekelijks','12-wekelijks','16-wekelijks','52-wekelijks'
]);

async function applyFeedback(pages) {
  if (!IS_RESET_DAY) return;

  // VEILIGHEIDSCHECK: als geen enkele taak afgevinkt is bij de start,
  // is er geen écht feedback-signaal (= app werkte niet of niemand werkte).
  // Sla feedback-loop dan over om valse 'Gemist'-markeringen te vermijden.
  const anyVoltooid = pages.some(p => p.properties.Voltooid && p.properties.Voltooid.checkbox === true);
  if (!anyVoltooid) {
    console.log('Feedback-loop overgeslagen: geen enkele taak afgevinkt vorige werkweek (lege of niet-werkende week).');
    return;
  }

  console.log(`Feedback-loop start (vorige werkweek = week ${prevWeek})`);

  // Stap 1: ruim alle eerdere Gemist-markeringen op
  const teResetten = pages.filter(p =>
    p.properties.Gemist && p.properties.Gemist.checkbox === true
  );
  if (teResetten.length) {
    console.log(`  ${teResetten.length} eerdere Gemist-vlaggen opruimen...`);
    for (const page of teResetten) {
      try {
        await notionPatch(page.id, { Gemist: { checkbox: false } });
        page.properties.Gemist.checkbox = false;
      } catch(e) {
        console.error(`  Gemist-reset fout ${page.id}: ${e.message}`);
      }
      await wait(RATE_DELAY_MS);
    }
  }

  // Stap 2: bepaal feedback per niet-afgevinkte taak
  let nGemist = 0;
  let nDoorgeschoven = 0;
  for (const page of pages) {
    const p = page.properties;
    const voltooid = (p.Voltooid && p.Voltooid.checkbox) || false;
    if (voltooid) continue;

    const freq    = (p.frequentie && p.frequentie.select && p.frequentie.select.name) || '';
    const start   = (p.Startdatum && p.Startdatum.date && p.Startdatum.date.start) || '';
    const weekdag = ((p.Weekdag && p.Weekdag.multi_select) || []).map(w => w.name);
    const naam    = ((p.Taak && p.Taak.title) || []).map(r => r.plain_text).join('');

    let stondOpLijst = false;
    if (weekdag.includes('elke weekdag') || freq === 'dagelijks' || freq === '2x/week') {
      stondOpLijst = true;
    } else if (weekdag.length > 0) {
      stondOpLijst = isActief(freq, start, prevWeek);
    }
    if (!stondOpLijst) continue;

    if (freq === 'wekelijks') {
      try {
        await notionPatch(page.id, { Gemist: { checkbox: true } });
        if (!p.Gemist) p.Gemist = { checkbox: true };
        else p.Gemist.checkbox = true;
        nGemist++;
        console.log(`  Gemist gemarkeerd: ${naam}`);
      } catch(e) {
        console.error(`  Gemist-set fout ${page.id}: ${e.message}`);
      }
      await wait(RATE_DELAY_MS);
    } else if (FREQ_MINDER_DAN_WEKELIJKS.has(freq)) {
      if (!start) continue;
      const oud = new Date(start);
      const nieuw = new Date(oud); nieuw.setDate(oud.getDate() + 7);
      const nieuwStr = nieuw.toISOString().slice(0,10);
      try {
        await notionPatch(page.id, { Startdatum: { date: { start: nieuwStr } } });
        p.Startdatum.date.start = nieuwStr;
        nDoorgeschoven++;
        console.log(`  Doorgeschoven (${freq}): ${naam} -> ${nieuwStr}`);
      } catch(e) {
        console.error(`  Startdatum-update fout ${page.id}: ${e.message}`);
      }
      await wait(RATE_DELAY_MS);
    }
  }

  console.log(`Feedback-loop klaar: ${nGemist} gemist-markeringen, ${nDoorgeschoven} doorschuivingen.`);
}

// ── Maandag: reset alle Voltooid-vlaggen in Notion ───────────────
async function resetWeekIfMonday(pages) {
  if (!IS_RESET_DAY) return;
  const toReset = pages.filter(p => p.properties.Voltooid && p.properties.Voltooid.checkbox === true);
  if (!toReset.length) {
    console.log('Maandag: alle Voltooid-vlaggen staan al op false.');
    return;
  }
  console.log(`Maandag: ${toReset.length} Voltooid-vlaggen resetten naar false...`);
  for (const page of toReset) {
    try {
      await notionPatch(page.id, { Voltooid: { checkbox: false } });
    } catch(e) {
      console.error(`Reset fout ${page.id}: ${e.message}`);
    }
    await wait(RATE_DELAY_MS);
  }
  console.log('Voltooid-reset klaar.');
}

// ── Parse Notion pagina ──────────────────────────────────────────
function parsePage(page) {
  const p = page.properties;
  return {
    id:       page.id,
    taak:     (p.Taak?.title || []).map(r => r.plain_text).join(''),
    person:   p.Verantwoordelijke?.select?.name || '',
    weekdag:  (p.Weekdag?.multi_select || []).map(w => w.name),
    freq:     p.frequentie?.select?.name || '',
    start:    p.Startdatum?.date?.start || '',
    inst:     (p.instructie?.rich_text || []).map(r => r.plain_text).join(''),
    voltooid: IS_RESET_DAY ? false : (p.Voltooid?.checkbox || false),
    gemist:   p.Gemist?.checkbox || false
  };
}

// ── HTML helpers ─────────────────────────────────────────────────
const CB = '<svg viewBox="0 0 26 26" width="26" height="26"><circle class="cb-c" cx="13" cy="13" r="11"/><circle class="cb-b" cx="13" cy="13" r="11"/><polyline class="cb-k" points="7,13 11,17 19,9"/></svg>';

function esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;')
    .replace(/\$/g, '&#36;')
    .replace(/\n/g, ' | ')
    .replace(/\r/g, '')
    .replace(/\xa0/g, ' ')
    .trim();
}

function T(name, inst, pageId, voltooid, gemist) {
  const i = inst ? `<div class="ti">&rarr; ${esc(inst)}</div>` : '';
  const doneClass   = voltooid ? ' done' : '';
  const missedClass = gemist   ? ' missed' : '';
  const idAttr      = pageId ? ` data-id="${pageId}"` : '';
  return `<div class="ti-w${doneClass}${missedClass}" onclick="TK(this)"${idAttr}><div class="cb">${CB}</div><div class="tt"><div class="tn">${esc(name)}</div>${i}</div></div>`;
}
function L(txt, bg) { return `<div class="sl" style="background:${bg};color:#fff">${txt}</div>`; }
// ── Hoofd ────────────────────────────────────────────────────────
async function main() {
  const pages = await queryNotion();

  // 1) Op maandag: feedback-loop (gebruikt Voltooid-status van vorige week)
  await applyFeedback(pages);

  // 2) Op maandag: vorige week-vinkjes wissen in Notion
  await resetWeekIfMonday(pages);

  const tasks = pages.map(parsePage).filter(t => t.taak && t.person);

  const data = {};
  for (const naam of VOLGORDE) {
    data[naam] = { daily: [], dag: {ma:[],di:[],wo:[],do:[],vr:[]} };
  }

  const DAGMAP = {maandag:'ma',dinsdag:'di',woensdag:'wo',donderdag:'do',vrijdag:'vr'};

  for (const t of tasks) {
    const naam = t.person;
    if (!data[naam]) continue;

    if (t.weekdag.includes('elke weekdag') || t.freq === 'dagelijks') {
      data[naam].daily.push({t: t.taak, i: t.inst, id: t.id, v: t.voltooid, m: t.gemist});
      continue;
    }

    for (const wd of t.weekdag) {
      const k = DAGMAP[wd];
      if (!k) continue;
      if (isActief(t.freq, t.start, week)) {
        data[naam].dag[k].push({t: t.taak, i: t.inst, id: t.id, v: t.voltooid, m: t.gemist});
      }
    }
  }

  let personen = '';
  for (const naam of VOLGORDE) {
    const p    = data[naam];
    const kl   = KLEUREN[naam] || {h:'#555',d:'#888',dl:'#666'};
    const disp = DISPLAY[naam] || naam;

    let dagHTML = ''; let first = true;
    for (const dag of DAGEN) {
      if (isHoliday(dag.d)) {
        dagHTML += `<div class="dc"><div class="dh" style="background:#E74C3C"><h2>${dag.l} &mdash; Feestdag &#127881;</h2></div><div class="db"><div class="ed">Geen werk vandaag.</div></div></div>`;
        continue;
      }
      const dagTaken = p.dag[dag.k] || [];
      if (!dagTaken.length && !p.daily.length) continue;

      const col = first ? '' : ' class="collapsed"';
      first = false;
      let inner = '';
      if (p.daily.length)  inner += L('DAGELIJKSE TAKEN', kl.dl) + p.daily.map(t=>T(t.t, t.i, t.id, t.v, t.m)).join('');
      if (dagTaken.length) inner += L(`EXTRA ${dag.l.toUpperCase()}`, kl.d) + dagTaken.map(t=>T(t.t, t.i, t.id, t.v, t.m)).join('');
      if (!inner) continue;

      dagHTML += `<div class="dc"><div class="dh" style="background:${kl.h}" onclick="toggleDay(this)"><h2>${dag.l}</h2><span class="db-badge" id="b-${naam}-${dag.k}">0/0</span></div><div${col} id="d-${naam}-${dag.k}">${inner}</div></div>`;
    }
    if (!dagHTML) {
      dagHTML = `<div class="dc"><div class="dh" style="background:${kl.h}"><h2>Geen taken deze week</h2></div><div class="db"><div class="ed">Geen taken gepland voor deze week.</div></div></div>`;
    }

    const active = naam === 'Rita' ? ' active' : '';
    personen += `<div class="pv${active}" id="v-${naam}" data-p="${naam}"><div class="pw"><div class="pt-info"><span style="color:${kl.h};font-weight:700">${disp}</span><span class="pc" id="prog-${naam}">0/0</span></div><div class="pb-bg"><div class="pb-fill" id="bar-${naam}" style="background:${kl.h};width:0%"></div></div></div>${dagHTML}<button class="rb" style="background:${kl.h}" onclick="Reset('${naam}')">&#8635; Nieuwe week starten</button></div>`;
  }

  const tabs = VOLGORDE.map((n,i) =>
    `<div class="pt${i===0?' active':''}" data-p="${n}">${DISPLAY[n]}</div>`
  ).join('');

  // CSS — met NIEUW .ti-w.missed voor gemiste taken
  const CSS = `*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}body{font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;background:#F0F2F5}.ah{background:#1C2833;color:#fff;padding:14px 20px 0;position:sticky;top:0;z-index:100;box-shadow:0 2px 12px rgba(0,0,0,.25)}.ah-top{display:flex;justify-content:space-between;align-items:center}.ah h1{font-size:19px;font-weight:700}.ah p{font-size:12px;opacity:.65;margin-top:2px}.rfb{background:rgba(255,255,255,.12);border:none;color:rgba(255,255,255,.8);font-size:13px;padding:5px 12px;border-radius:14px;cursor:pointer;white-space:nowrap}.rfb:active{background:rgba(255,255,255,.25)}.pt-wrap{display:flex;overflow-x:auto;scrollbar-width:none;margin-top:10px}.pt-wrap::-webkit-scrollbar{display:none}.pt{flex:1;min-width:70px;padding:9px 6px 7px;text-align:center;font-size:13px;font-weight:600;color:rgba(255,255,255,.5);cursor:pointer;border-bottom:3px solid transparent;white-space:nowrap;transition:all .2s;user-select:none}.pt.active{color:#fff;border-bottom-color:#fff}.cnt{max-width:700px;margin:0 auto;padding:14px 12px 80px}.pv{display:none}.pv.active{display:block}.pw{background:#fff;border-radius:12px;padding:12px 16px;margin-bottom:12px;box-shadow:0 2px 10px rgba(0,0,0,.1)}.pt-info{display:flex;justify-content:space-between;align-items:center;margin-bottom:7px;font-size:14px}.pb-bg{background:#E8E8E8;border-radius:6px;height:7px}.pb-fill{height:7px;border-radius:6px;transition:width .4s}.pc{font-size:13px;color:#666;font-weight:400}.dc{background:#fff;border-radius:12px;margin-bottom:12px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.1)}.dh{display:flex;justify-content:space-between;align-items:center;padding:11px 16px;cursor:pointer;user-select:none}.dh h2{font-size:15px;font-weight:700;color:#fff}.db-badge{font-size:12px;color:rgba(255,255,255,.85);background:rgba(255,255,255,.2);border-radius:10px;padding:2px 9px}.collapsed{display:none}.sl{font-size:11px;font-weight:700;letter-spacing:.7px;padding:6px 16px;text-transform:uppercase}.ti-w{display:flex;align-items:flex-start;padding:11px 16px;gap:13px;cursor:pointer;border-bottom:1px solid #F5F5F5;min-height:50px;transition:background .15s}.ti-w:last-child{border-bottom:none}.ti-w.done{background:#F0FFF4}.ti-w.done .tn{color:#AAA;text-decoration:line-through}.ti-w.missed{background:#FDF2F2}.ti-w.missed .tn{color:#C0392B;font-weight:800;text-transform:uppercase;letter-spacing:.4px}.ti-w.missed.done{background:#F0FFF4}.ti-w.missed.done .tn{color:#AAA;text-decoration:line-through;font-weight:400;text-transform:none;letter-spacing:0}.cb{width:26px;height:26px;flex-shrink:0;margin-top:1px}.cb-c{fill:none;stroke:#CCC;stroke-width:2}.cb-b{fill:#CCC;opacity:0;transition:all .2s}.cb-k{fill:none;stroke:#fff;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;opacity:0;transition:opacity .2s}.ti-w.done .cb-c{stroke:#2ECC71}.ti-w.done .cb-b{fill:#2ECC71;opacity:1}.ti-w.done .cb-k{opacity:1}.tt{flex:1}.tn{font-size:15px;line-height:1.35;color:#1A1A1A}.ti{font-size:12px;color:#777;font-style:italic;margin-top:3px}.db,.ed{padding:14px 16px;font-size:13px;color:#BBB;font-style:italic}.rb{display:block;width:calc(100% - 24px);margin:4px 12px 0;padding:13px;border:none;border-radius:12px;font-size:15px;font-weight:600;color:#fff;cursor:pointer;opacity:.85}.rb:active{opacity:1}.si{position:fixed;bottom:22px;right:16px;background:rgba(28,40,51,.85);color:#fff;font-size:12px;padding:6px 14px;border-radius:20px;display:none;z-index:200;pointer-events:none;backdrop-filter:blur(4px)}.si.v{display:block}`;

  const WORKER_URL = 'https://berkenhof-sync.ilse-vanderschueren.workers.dev';
  const JS = `var cP='Rita';` +
    `var WK='${WORKER_URL}';` +
    `var VOLGORDE=${JSON.stringify(VOLGORDE)};` +
    `function TK(el){el.classList.toggle('done');var d=el.classList.contains('done');var id=el.dataset.id;if(id)pN(id,d);UP(cP);UB(cP)}` +
    `function pN(pid,done){var si=document.getElementById('si');si.classList.add('v');clearTimeout(si._t);si._t=setTimeout(function(){si.classList.remove('v');},1800);fetch(WK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'patch',pageId:pid,done:done})}).catch(function(){});}` +
    `function loadState(){fetch(WK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'state'})}).then(function(r){return r.json();}).then(function(data){if(!data.results)return;data.results.forEach(function(p){var el=document.querySelector('[data-id="'+p.id+'"]');if(el&&!el.classList.contains('done'))el.classList.add('done');});VOLGORDE.forEach(function(p){UP(p);UB(p);});}).catch(function(){});}` +
    `function toggleDay(h){h.nextElementSibling.classList.toggle('collapsed')}` +
    `function Reset(p){document.querySelectorAll('.ti-w').forEach(function(t){t.classList.remove('done');});VOLGORDE.forEach(function(n){if(document.getElementById('v-'+n)){UP(n);UB(n);}});fetch(WK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'state'})}).then(function(r){return r.json();}).then(function(data){(data.results||[]).forEach(function(r){if(r.id)pN(r.id,false);});}).catch(function(e){console.warn('Reset Notion fout:',e);});}` +
    `function UP(p){var v=document.getElementById('v-'+p),a=v.querySelectorAll('.ti-w'),d=v.querySelectorAll('.ti-w.done'),pct=a.length?Math.round(d.length/a.length*100):0;document.getElementById('bar-'+p).style.width=pct+'%';document.getElementById('prog-'+p).textContent=d.length+'/'+a.length}` +
    `function UB(p){document.querySelectorAll('#v-'+p+' [id^="b-'+p+'"]').forEach(function(b){var day=b.id.split('-').pop(),body=document.getElementById('d-'+p+'-'+day);if(!body)return;var a=body.querySelectorAll('.ti-w'),d=body.querySelectorAll('.ti-w.done');b.textContent=d.length+'/'+a.length;b.style.background=d.length===a.length&&a.length>0?'rgba(46,204,113,.7)':'rgba(255,255,255,.2)'})}` +
    `document.querySelector('.pt-wrap').addEventListener('click',function(e){var t=e.target.closest('.pt');if(!t)return;cP=t.dataset.p;document.querySelectorAll('.pt').forEach(function(x){x.classList.remove('active')});document.querySelectorAll('.pv').forEach(function(x){x.classList.remove('active')});t.classList.add('active');document.getElementById('v-'+cP).classList.add('active')});` +
    `${VOLGORDE.map(p=>`UP(${JSON.stringify(p)});UB(${JSON.stringify(p)});`).join('')}`;

  const PIN_JS = `(function(){var PIN='3360';if(sessionStorage.getItem('bk_auth')==='1'){setTimeout(function(){if(typeof loadState==='function')loadState();},0);return;}var ov=document.createElement('div');ov.id='pin-overlay';ov.innerHTML='<div id="pin-box"><div id="pin-logo">&#127968;</div><div id="pin-title">Berkenhof</div><div id="pin-sub">Voer de pincode in</div><div id="pin-dots"><span></span><span></span><span></span><span></span></div><div id="pin-err"></div><div id="pin-grid"><button onclick="pk(1)">1</button><button onclick="pk(2)">2</button><button onclick="pk(3)">3</button><button onclick="pk(4)">4</button><button onclick="pk(5)">5</button><button onclick="pk(6)">6</button><button onclick="pk(7)">7</button><button onclick="pk(8)">8</button><button onclick="pk(9)">9</button><button onclick="pk(11)">&#9003;</button><button onclick="pk(0)">0</button><button onclick="pk(12)">OK</button></div></div>';ov.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;background:#1C2833;display:flex;align-items:center;justify-content:center;z-index:9999';document.head.insertAdjacentHTML('beforeend','<style>#pin-box{background:#253341;border-radius:20px;padding:36px 28px;text-align:center;width:300px;box-shadow:0 8px 32px rgba(0,0,0,.4)}#pin-logo{font-size:48px;margin-bottom:8px}#pin-title{color:#fff;font-size:22px;font-weight:700;font-family:-apple-system,Arial,sans-serif}#pin-sub{color:rgba(255,255,255,.5);font-size:14px;margin:6px 0 20px;font-family:-apple-system,Arial,sans-serif}#pin-dots{display:flex;justify-content:center;gap:14px;margin-bottom:20px}#pin-dots span{width:14px;height:14px;border-radius:50%;background:rgba(255,255,255,.2);transition:background .2s}#pin-dots span.filled{background:#5DADE2}#pin-err{color:#E74C3C;font-size:13px;height:18px;margin-bottom:8px;font-family:-apple-system,Arial,sans-serif}#pin-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}#pin-grid button{background:rgba(255,255,255,.1);border:none;border-radius:12px;color:#fff;font-size:20px;font-weight:600;padding:16px;cursor:pointer;font-family:-apple-system,Arial,sans-serif;transition:background .15s}#pin-grid button:active{background:rgba(255,255,255,.25)}</style>');document.body.appendChild(ov);var en='';function pk(k){if(k===11){en=en.slice(0,-1);}else if(k===12){ch();}else if(en.length<4){en+=k;}ud();if(en.length===4)setTimeout(ch,200);}function ud(){var d=document.querySelectorAll('#pin-dots span');d.forEach(function(s,i){s.classList.toggle('filled',i<en.length);});}function ch(){if(en===PIN){sessionStorage.setItem('bk_auth','1');document.getElementById('pin-overlay').remove();setTimeout(function(){if(typeof loadState==='function')loadState();},0);}else{document.getElementById('pin-err').textContent='Verkeerde pincode';en='';ud();setTimeout(function(){document.getElementById('pin-err').textContent='';},2000);}}window.pk=pk;})();`;

  const html = `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Berkenhof Taken">
<title>Berkenhof Taken</title>
<style>${CSS}</style>
</head>
<body>
<div class="ah">
  <div class="ah-top">
    <h1>&#127968; Berkenhof</h1>
    <button class="rfb" onclick="loadState()">&#8635; Ververs</button>
  </div>
  <p>Week ${weekLabel}</p>
  <div class="pt-wrap">${tabs}</div>
</div>
<div class="cnt">${personen}</div>
<div id="si" class="si">&#8635; Synchroniseren&hellip;</div>
<script>${PIN_JS}${JS}<\/script>
</body>
</html>`;

  fs.writeFileSync('berkenhof_taken.html', html);
  console.log(`Week ${week} gegenereerd (${weekLabel}): ${html.length} bytes`);
}

main().catch(err => { console.error('Fout:', err); process.exit(1); });
