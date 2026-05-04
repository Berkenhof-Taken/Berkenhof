// Berkenhof – Automatische weeklijst generator
// Draait elke vrijdag via GitHub Actions

const fs = require('fs');

// ── ISO weeknummer ───────────────────────────────────────────────
function getISOWeek(d) {
  const jan4 = new Date(d.getFullYear(), 0, 4);
  const dow  = jan4.getDay() || 7;
  const w1   = new Date(jan4); w1.setDate(jan4.getDate() + 1 - dow);
  const diff = Math.floor((d - w1) / 86400000);
  return diff < 0 ? getISOWeek(new Date(d.getFullYear()-1, 11, 28)) : Math.floor(diff/7) + 1;
}

// ── Belgische feestdagen ─────────────────────────────────────────
const FEESTDAGEN = new Set([
  '2026-05-21','2026-06-01','2026-07-21','2026-08-15',
  '2026-11-01','2026-11-11','2026-12-25',
  '2027-01-01','2027-03-29','2027-05-01','2027-05-13',
  '2027-05-24','2027-07-21','2027-08-15','2027-11-01',
  '2027-11-11','2027-12-25'
]);

function dateStr(d) { return d.toISOString().slice(0,10); }
function isHoliday(d) { return FEESTDAGEN.has(dateStr(d)); }

// ── Is taak actief? ──────────────────────────────────────────────
function isActief(freq, start, targetWeek) {
  if (['wekelijks','dagelijks','2x/week','elke weekdag'].includes(freq)) return true;
  if (!start) return false;
  const sw = getISOWeek(new Date(start));
  const d  = targetWeek - sw;
  if (d < 0) return false;
  const fw = {'2-wekelijks':2,'3-wekelijks':3,'4-wekelijks':4,'6-wekelijks':6,
               '8-wekelijks':8,'12-wekelijks':12,'16-wekelijks':16,'52-wekelijks':52}[freq];
  return fw ? d % fw === 0 : false;
}

// ── Volgende maandag ─────────────────────────────────────────────
const today = new Date(); today.setHours(0,0,0,0);
const dow   = today.getDay() || 7;
const ma    = new Date(today); ma.setDate(today.getDate() + (dow === 1 ? 7 : 8 - dow));
const week  = getISOWeek(ma);

const MAANDEN = ['','januari','februari','maart','april','mei','juni',
                 'juli','augustus','september','oktober','november','december'];
function fmt(d) { return `${d.getDate()} ${MAANDEN[d.getMonth()+1]}`; }

const DAGEN = [
  {k:'ma', l:`Maandag ${fmt(ma)}`,          d: new Date(ma)},
  {k:'di', l:`Dinsdag ${fmt(new Date(ma.getTime()+86400000))}`,  d: new Date(ma.getTime()+86400000)},
  {k:'wo', l:`Woensdag ${fmt(new Date(ma.getTime()+172800000))}`, d: new Date(ma.getTime()+172800000)},
  {k:'do', l:`Donderdag ${fmt(new Date(ma.getTime()+259200000))}`, d: new Date(ma.getTime()+259200000)},
  {k:'vr', l:`Vrijdag ${fmt(new Date(ma.getTime()+345600000))}`,  d: new Date(ma.getTime()+345600000)},
];
const weekLabel = `${fmt(ma)} – ${fmt(new Date(ma.getTime()+345600000))} ${ma.getFullYear()}`;

// ── Taakdata ─────────────────────────────────────────────────────
const TAKEN = {
  Rita: {
    h:'#A0522D', d:'#F0B27A', dl:'#D4A843',
    daily: [
      {t:'Ontbijt klaarmaken', i:'koffie, melk, toast, spiegelei, boter, confituur, fruitsap, water, supplementen, oikos, kiwi, granaatappelpitten, blauwe bessen, margarine'},
      {t:'CPAP-bevochtigingsapparaat spoelen en leegmaken, CPAP masker reinigen'},
      {t:'Glazen en tassen N2 afruimen'},
      {t:'Aanrechtblad schoon en opgeruimd (keuken, bijkeuken en garage)'},
      {t:'Bedden opmaken'},
      {t:"WC's nakijken (borstel in pot, rand/bril/drukknop/deurklink, WC-papier)"},
      {t:'Alle vuilbakken ledigen (ook burelen)'},
      {t:'Wastafels snel reinigen'},
      {t:'Brood bakken'},
      {t:'Wassen / strijken / propere was naar dressing brengen'},
      {t:'Eten voorbereiden'},
      {t:'Stoomoven spoelen'},
      {t:'Wasmachine / droogkast opzetten'},
      {t:'Wasbak schuren, kookplaat opblinken met vitroclean'},
      {t:'Deuren sluiten (strijkzolder, terras, deur naar schuur in slot)'},
    ],
    dag: {
      ma: [{t:'Handdoeken in badkamers ouders en kinderen verversen',f:'wekelijks',s:''},
           {t:'Data biofrigo nakijken',f:'wekelijks',s:''},
           {t:'Data kasten keuken nakijken',f:'4-wekelijks',s:'2026-04-28'}],
      di: [{t:'Spiegels en kranen snel opwrijven',f:'wekelijks',s:''},
           {t:'Schotelvod en keukenhanddoeken verversen',f:'wekelijks',s:''},
           {t:'Orde in de ijskast — bijvullen, data nakijken, restjes > 1 dag oud weg',f:'wekelijks',s:''},
           {t:'Koffiemachine controleren',f:'wekelijks',s:''},
           {t:'Soda kristallen in brouilleurs',f:'wekelijks',s:''},
           {t:'Sterilisator wasplaats poetsen',f:'wekelijks',s:''},
           {t:'Ijskast keuken uitkuisen',i:'Ook eierplateau, alle begonnen zaken nakijken',f:'2-wekelijks',s:'2026-03-07'},
           {t:'CPAP luchtfilter en toestel reinigen',f:'4-wekelijks',s:'2026-03-07'}],
      wo: [{t:'Kranen grondig (keuken, bijkeuken en garage)',f:'2-wekelijks',s:'2026-02-21'},
           {t:'Boodschappenlijst maken',f:'wekelijks',s:''}],
      do: [{t:'Broodmachine reinigen',f:'wekelijks',s:''},
           {t:'Klinken met vochtig doekje, trapleuningen en displays afnemen',f:'2-wekelijks',s:'2026-04-30'},
           {t:'Voorraadpotjes sorteren',f:'2-wekelijks',s:'2026-04-30'},
           {t:'Was en strijk Opa',f:'wekelijks',s:''}],
      vr: [{t:'Schotelvod en keukenhanddoeken verversen',f:'wekelijks',s:''},
           {t:'Orde in de ijskast — bijvullen, data nakijken, restjes > 1 dag oud weg',f:'wekelijks',s:''},
           {t:'Koffiemachine controleren',f:'wekelijks',s:''},
           {t:'Kookplaat met vitroclean opblinken',f:'wekelijks',s:''},
           {t:'Zout in afwasmachines',f:'wekelijks',s:''},
           {t:'Beide afwasmachines ledigen voor vertrek',f:'wekelijks',s:''},
           {t:'Naspoelmiddel en zout in vaatwasmachine',f:'wekelijks',s:''},
           {t:'Soep voorzien voor het hele weekend',f:'wekelijks',s:''},
           {t:'Koffiemachine klaarmaken voor het weekend',f:'wekelijks',s:''},
           {t:'Propere was naar dressing brengen',f:'wekelijks',s:''}]
    }
  },
  Wioletta: {
    h:'#4A235A', d:'#C39BD3', dl:'#9B59B6',
    daily: [],
    dag: {
      ma: [{t:"Perron et escaliers porte d'entree",f:'wekelijks',s:''},
           {t:'Cave fraiche',i:'Nettoyer les etageres / Laver le sol / Verifier tout',f:'wekelijks',s:''},
           {t:'Reapprovisionner le papier WC',f:'wekelijks',s:''}],
      di: [{t:'Nettoyer N1',f:'wekelijks',s:''},
           {t:'Living',i:'Aspirateur et lavage du sol. Secouer les coussins et le canape. Nettoyer les tables basses. Depoussierer tout.',f:'wekelijks',s:''},
           {t:'Nettoyer N2',f:'2-wekelijks',s:'2026-02-21'},
           {t:'Nettoyer les armoires de cuisine',f:'2-wekelijks',s:'2026-02-21'},
           {t:'Sellerie',f:'2-wekelijks',s:'2026-02-21'},
           {t:'Imop cuisine',f:'wekelijks',s:''},
           {t:'Escalier N0 a N2',f:'2-wekelijks',s:'2026-04-28'}],
      wo: [],
      do: [],
      vr: [{t:'Nettoyer la salle de piscine',f:'wekelijks',s:''},
           {t:'Salle Culot',i:'Soulever les rideaux, depoussierer, aspirateur et lavage du sol, swiffer en hauteur, nettoyer la table de reunion.',f:'4-wekelijks',s:'2026-05-08'},
           {t:'Salle de massage et debarras derriere la salle voutee W',f:'4-wekelijks',s:'2026-05-08'},
           {t:'Porte-savon douche piscine',f:'8-wekelijks',s:'2026-05-08'}]
    }
  },
  Jon: {
    h:'#1A5276', d:'#5DADE2', dl:'#2E86C1',
    daily: [{t:'Dieren eten geven'},{t:'Check grasrobots en mollen'},{t:'Beton voor stallen borstelen'}],
    dag: {
      ma: [{t:'Schuur',f:'wekelijks',s:''},
           {t:'Hondenstronten opruimen van gazon',f:'wekelijks',s:''},
           {t:'Roombas controleren (leegmaken, wielen en filters, apparaten ontstoffen)',f:'wekelijks',s:''},
           {t:'Mat aan keukenterras reinigen',f:'wekelijks',s:''},
           {t:'Honden borstelen',f:'wekelijks',s:''},
           {t:'Roomba in keuken hoekwoning',f:'wekelijks',s:''},
           {t:'Klimaatdetail nakijken',f:'wekelijks',s:''}],
      di: [{t:'Vuilbakken buiten zetten',f:'wekelijks',s:''}],
      wo: [{t:'Hondenstronten opruimen van gazon',f:'wekelijks',s:''}],
      do: [{t:'Roombas controleren',f:'wekelijks',s:''},
           {t:'Mat aan keukenterras reinigen',f:'wekelijks',s:''},
           {t:'Honden borstelen',f:'wekelijks',s:''},
           {t:'Roomba in keuken hoekwoning',f:'wekelijks',s:''},
           {t:'Klimaatdetail nakijken',f:'wekelijks',s:''},
           {t:'Collect and go',f:'wekelijks',s:''}],
      vr: [{t:'Vuilbakken keuken leegmaken voor vertrek',f:'wekelijks',s:''},
           {t:'Vuilbakken garage leegmaken',f:'wekelijks',s:''},
           {t:'Hondenstronten opruimen van gazon',f:'wekelijks',s:''}]
    }
  },
  Karin: {
    h:'#1E8449', d:'#52BE80', dl:'#27AE60',
    daily: [],
    dag: {
      ma: [{t:'Lakens ouders verversen',f:'wekelijks',s:''}],
      di: [{t:'Zadeldekens wassen',f:'wekelijks',s:''}],
      wo: [],
      do: [{t:'Alles stofzuigersfilters en borstels proper maken',f:'4-wekelijks',s:'2026-03-07'},
           {t:'Ramen binnenkant Living en keuken',i:'Ook glasdeuren naar garage toe',f:'12-wekelijks',s:'2026-04-30'}],
      vr: []
    }
  },
  Loic: {
    h:'#784212', d:'#F0B27A', dl:'#CA6F1E',
    daily: [],
    dag: {
      ma: [{t:'Schapen nazicht en stalletjes',i:'Nazicht van de schapen. Stalletjes proper houden.',f:'wekelijks',s:''},
           {t:'Stallen uitkuisen',i:'Etens- en drinkbakken proper maken.',f:'wekelijks',s:''},
           {t:'Honden borstelen en poes verzorgen',i:'Honden en poes borstelen. Hokken proper maken.',f:'wekelijks',s:''},
           {t:'Paarden borstelen en hoeven verzorgen',i:'Borstelen, kammen, hoeven verzorgen.',f:'wekelijks',s:''},
           {t:'Kippenhok proper maken en bijvullen',i:'Etensbak bijvullen, drinkbak proper en opvullen.',f:'wekelijks',s:''}],
      di:[], wo:[], do:[], vr:[]
    }
  }
};

// ── HTML genereren ───────────────────────────────────────────────
const CB = '<svg viewBox="0 0 26 26" width="26" height="26"><circle class="cb-c" cx="13" cy="13" r="11"/><circle class="cb-b" cx="13" cy="13" r="11"/><polyline class="cb-k" points="7,13 11,17 19,9"/></svg>';
function T(name, inst) { return `<div class="ti-w" onclick="T(this)"><div class="cb">${CB}</div><div class="tt"><div class="tn">${name}</div>${inst?`<div class="ti">&rarr; ${inst}`+'</div>':''}</div></div>`; }
function L(txt,bg) { return `<div class="sl" style="background:${bg};color:#fff">${txt}</div>`; }

const NAMES = ['Rita','Wioletta','Jon','Karin','Loic'];
const DISPLAY = {Rita:'Rita',Wioletta:'Wioletta',Jon:'Jon',Karin:'Karin',Loic:'Lo&#239;c'};

let personen = '';
for (const naam of NAMES) {
  const p = TAKEN[naam];
  let dagHTML = ''; let first = true;
  for (const dag of DAGEN) {
    if (isHoliday(dag.d)) {
      dagHTML += `<div class="dc"><div class="dh" style="background:#E74C3C"><h2>${dag.l} &mdash; Feestdag &#127881;</h2></div><div class="db"><div class="ed">Geen werk vandaag.</div></div></div>`;
      continue;
    }
    const dagTaken = (p.dag[dag.k]||[]).filter(t => isActief(t.f||'wekelijks', t.s||'', week));
    if (!dagTaken.length && !p.daily.length) continue;
    const col = first ? '' : ' class="collapsed"';
    first = false;
    let inner = '';
    if (p.daily.length) inner += L('DAGELIJKSE TAKEN', p.dl) + p.daily.map(t=>T(t.t,t.i||'')).join('');
    if (dagTaken.length) inner += L(`EXTRA ${dag.l.toUpperCase()}`, p.d) + dagTaken.map(t=>T(t.t,t.i||'')).join('');
    dagHTML += `<div class="dc"><div class="dh" style="background:${p.h}" onclick="toggleDay(this)"><h2>${dag.l}</h2><span class="db-badge" id="b-${naam}-${dag.k}">0/0</span></div><div${col} id="d-${naam}-${dag.k}">${inner}</div></div>`;
  }
  const active = naam === 'Rita' ? ' active' : '';
  personen += `<div class="pv${active}" id="v-${naam}" data-p="${naam}"><div class="pw"><div class="pt-info"><span style="color:${p.h};font-weight:700">${DISPLAY[naam]}</span><span class="pc" id="prog-${naam}">0/0</span></div><div class="pb-bg"><div class="pb-fill" id="bar-${naam}" style="background:${p.h};width:0%"></div></div></div>${dagHTML}<button class="rb" style="background:${p.h}" onclick="Reset('${naam}')">&#8635; Nieuwe week starten</button></div>`;
}

const CSS = `*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}body{font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;background:#F0F2F5}.ah{background:#1C2833;color:#fff;padding:14px 20px 0;position:sticky;top:0;z-index:100;box-shadow:0 2px 12px rgba(0,0,0,.25)}.ah h1{font-size:19px;font-weight:700}.ah p{font-size:12px;opacity:.65;margin-top:2px}.pt-wrap{display:flex;overflow-x:auto;scrollbar-width:none;margin-top:10px}.pt-wrap::-webkit-scrollbar{display:none}.pt{flex:1;min-width:70px;padding:9px 6px 7px;text-align:center;font-size:13px;font-weight:600;color:rgba(255,255,255,.5);cursor:pointer;border-bottom:3px solid transparent;white-space:nowrap;transition:all .2s;user-select:none}.pt.active{color:#fff;border-bottom-color:#fff}.cnt{max-width:700px;margin:0 auto;padding:14px 12px 80px}.pv{display:none}.pv.active{display:block}.pw{background:#fff;border-radius:12px;padding:12px 16px;margin-bottom:12px;box-shadow:0 2px 10px rgba(0,0,0,.1)}.pt-info{display:flex;justify-content:space-between;align-items:center;margin-bottom:7px;font-size:14px}.pb-bg{background:#E8E8E8;border-radius:6px;height:7px}.pb-fill{height:7px;border-radius:6px;transition:width .4s}.pc{font-size:13px;color:#666;font-weight:400}.dc{background:#fff;border-radius:12px;margin-bottom:12px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.1)}.dh{display:flex;justify-content:space-between;align-items:center;padding:11px 16px;cursor:pointer;user-select:none}.dh h2{font-size:15px;font-weight:700;color:#fff}.db-badge{font-size:12px;color:rgba(255,255,255,.85);background:rgba(255,255,255,.2);border-radius:10px;padding:2px 9px}.collapsed{display:none}.sl{font-size:11px;font-weight:700;letter-spacing:.7px;padding:6px 16px;text-transform:uppercase}.ti-w{display:flex;align-items:flex-start;padding:11px 16px;gap:13px;cursor:pointer;border-bottom:1px solid #F5F5F5;min-height:50px;transition:background .15s}.ti-w:last-child{border-bottom:none}.ti-w.done{background:#F0FFF4}.ti-w.done .tn{color:#AAA;text-decoration:line-through}.cb{width:26px;height:26px;flex-shrink:0;margin-top:1px}.cb-c{fill:none;stroke:#CCC;stroke-width:2}.cb-b{fill:#CCC;opacity:0;transition:all .2s}.cb-k{fill:none;stroke:#fff;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;opacity:0;transition:opacity .2s}.ti-w.done .cb-c{stroke:#2ECC71}.ti-w.done .cb-b{fill:#2ECC71;opacity:1}.ti-w.done .cb-k{opacity:1}.tt{flex:1}.tn{font-size:15px;line-height:1.35;color:#1A1A1A}.ti{font-size:12px;color:#777;font-style:italic;margin-top:3px}.ed{padding:14px 16px;font-size:13px;color:#BBB;font-style:italic}.rb{display:block;width:calc(100% - 24px);margin:4px 12px 0;padding:13px;border:none;border-radius:12px;font-size:15px;font-weight:600;color:#fff;cursor:pointer;opacity:.85}.rb:active{opacity:1}`;

const JS = `var cP='Rita';function T(el){el.classList.toggle('done');UP(cP);UB(cP)}function toggleDay(h){h.nextElementSibling.classList.toggle('collapsed')}function Reset(p){if(!confirm('Alle taken van '+p+' wissen?'))return;document.querySelectorAll('#v-'+p+' .ti-w').forEach(function(t){t.classList.remove('done')});UP(p);UB(p)}function UP(p){var v=document.getElementById('v-'+p),a=v.querySelectorAll('.ti-w'),d=v.querySelectorAll('.ti-w.done'),pct=a.length?Math.round(d.length/a.length*100):0;document.getElementById('bar-'+p).style.width=pct+'%';document.getElementById('prog-'+p).textContent=d.length+'/'+a.length}function UB(p){document.querySelectorAll('#v-'+p+' [id^="b-'+p+'"]').forEach(function(b){var day=b.id.split('-').pop(),body=document.getElementById('d-'+p+'-'+day);if(!body)return;var a=body.querySelectorAll('.ti-w'),d=body.querySelectorAll('.ti-w.done');b.textContent=d.length+'/'+a.length;b.style.background=d.length===a.length&&a.length>0?'rgba(46,204,113,.7)':'rgba(255,255,255,.2)'})}document.querySelector('.pt-wrap').addEventListener('click',function(e){var t=e.target.closest('.pt');if(!t)return;cP=t.dataset.p;document.querySelectorAll('.pt').forEach(function(x){x.classList.remove('active')});document.querySelectorAll('.pv').forEach(function(x){x.classList.remove('active')});t.classList.add('active');document.getElementById('v-'+cP).classList.add('active')});['Rita','Wioletta','Jon','Karin','Loic'].forEach(function(p){UP(p);UB(p)});`;

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
  <h1>&#127968; Berkenhof</h1>
  <p>Week ${weekLabel}</p>
  <div class="pt-wrap">
    <div class="pt active" data-p="Rita">Rita</div>
    <div class="pt" data-p="Wioletta">Wioletta</div>
    <div class="pt" data-p="Jon">Jon</div>
    <div class="pt" data-p="Karin">Karin</div>
    <div class="pt" data-p="Loic">Lo&#239;c</div>
  </div>
</div>
<div class="cnt">${personen}</div>
<script>${JS}<\/script>
</body>
</html>`;

fs.writeFileSync('berkenhof_taken.html', html);
console.log(`Week ${week} gegenereerd: ${html.length} bytes`);
