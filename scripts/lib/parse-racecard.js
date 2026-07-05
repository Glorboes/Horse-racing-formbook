'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeName } = require('./names');

// Parse a racecard into one or more normalized race objects:
// { date, track, race, distance, going, surface, runners:[{no,name,draw,weight,rating,gear,jockey,trainer}] }
//
// Returns { races: [...], review? }.  A TAB Computaform PDF holds a whole
// meeting (10+ races) — we return every race. .json/.txt/.csv are single-race.
//
//   .json  -> already-structured race (single)
//   .txt   -> pipe/CSV rows or key:value header (single)
//   .pdf   -> TAB Computaform official racecard (full meeting, multi-race)

const MONTHS = { january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',july:'07',august:'08',september:'09',october:'10',november:'11',december:'12' };

async function parseRacecard(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') return { races: [normalizeRace(JSON.parse(fs.readFileSync(file, 'utf8')))] };
  if (ext === '.txt' || ext === '.csv') return { races: [parseText(fs.readFileSync(file, 'utf8'), file)] };
  if (ext === '.pdf') return parsePdf(file);
  throw new Error(`Unsupported racecard type: ${ext} (use .pdf, .json, .txt, .csv)`);
}

function normalizeRace(r) {
  r.runners = (r.runners || []).map((x, i) => ({
    no: x.no ?? i + 1,
    name: (x.name || '').trim(),
    draw: x.draw ?? null,
    weight: x.weight ?? null,
    rating: x.rating ?? null,
    gear: x.gear ?? '',
    oddsFrac: x.oddsFrac ?? null,
    oddsDecimal: x.oddsDecimal ?? null,
    jockey: x.jockey ?? null,
    trainer: x.trainer ?? null,
    careerStats: x.careerStats ?? null,
  })).filter((x) => x.name);
  r.race = r.race ?? r.raceNo ?? 1;
  r.time = r.time ?? null;
  r.distance = r.distance ?? null;
  r.going = r.going ?? null;
  r.surface = r.surface ?? null;
  r.classLabel = r.classLabel ?? r.class ?? null;
  r.classType = r.classType ?? null;
  r.classRank = r.classRank ?? null;
  r.track = r.track ?? null;
  r.date = r.date ?? new Date().toISOString().slice(0, 10);
  return r;
}

// TXT/CSV: header line "date: … / track: … / race: … / distance: … / going: …"
// then one runner per row: no | name | draw | weight | rating | jockey | trainer
function parseText(text, file) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const meta = { race: 1 };
  const runners = [];
  for (const line of lines) {
    if (/^#/.test(line)) continue;
    const kv = line.match(/^(date|track|race|distance|going)\s*[:=]\s*(.+)$/i);
    if (kv) { meta[kv[1].toLowerCase()] = coerce(kv[1].toLowerCase(), kv[2]); continue; }
    const cols = line.split(/\s*[|\t,]\s*/);
    if (cols.length >= 2 && cols[0].toLowerCase() === 'no') continue;
    if (cols.length >= 2) {
      runners.push({ no: num(cols[0]), name: cols[1], draw: num(cols[2]), weight: num(cols[3]), rating: num(cols[4]), jockey: cols[5] || null, trainer: cols[6] || null });
    }
  }
  if (!runners.length) throw new Error(`No runners parsed from ${path.basename(file)}`);
  return normalizeRace({ ...meta, runners });
}

async function parsePdf(file) {
  let pdfParse;
  try { pdfParse = require('pdf-parse'); }
  catch {
    throw new Error('PDF parsing needs "pdf-parse" (npm install pdf-parse), or convert to .txt/.json.');
  }
  const { text } = await pdfParse(fs.readFileSync(file));
  const parsed = parseComputaform(text);

  const reviewDir = path.resolve(__dirname, '..', '..', 'data', 'review');
  fs.mkdirSync(reviewDir, { recursive: true });
  const stub = path.join(reviewDir, path.basename(file, '.pdf') + '.parsed.json');

  if (!parsed || !parsed.races.length) {
    fs.writeFileSync(stub, JSON.stringify({ error: 'Could not locate the "FIELDS, RATINGS" section — is this a TAB Computaform card?', textStart: text.slice(0, 400) }, null, 2) + '\n');
    throw new Error(`Could not parse Computaform PDF — wrote diagnostic to ${stub}. Try the .txt fallback.`);
  }
  const races = parsed.races.map(normalizeRace);
  fs.writeFileSync(stub, JSON.stringify({ date: parsed.date, track: parsed.track, races }, null, 2) + '\n');
  return { races, review: stub };
}

// --- TAB Computaform "FIELDS, RATINGS FOR <TRACK> <course> <Day D Month YYYY>" ---
function parseComputaform(text) {
  const s = text.indexOf('FIELDS, RATINGS FOR');
  if (s < 0) return null;
  const sect = text.slice(s);
  const head = sect.slice(0, 160);
  const track = (head.match(/FIELDS, RATINGS FOR\s+([A-Za-z][A-Za-z ]+?)\s+(?:STANDSIDE|INSIDE|POLYTRACK|POLY|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)/i) || [])[1];
  const dm = head.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  const date = dm && MONTHS[dm[2].toLowerCase()] ? `${dm[3]}-${MONTHS[dm[2].toLowerCase()]}-${String(dm[1]).padStart(2, '0')}` : null;

  const starts = [];
  const re = /\n\s*(\d{1,2})\s*\n\s*(\d{1,2}:\d{2})\s*-\s*/g;
  let m;
  while ((m = re.exec(sect))) starts.push({ no: +m[1], time: m[2], idx: m.index });
  const races = [];
  for (let i = 0; i < starts.length; i++) {
    const block = sect.slice(starts[i].idx, i + 1 < starts.length ? starts[i + 1].idx : sect.length);
    const rc = parseRaceBlock(block, starts[i].no);
    if (rc && rc.runners.length) races.push({ date, track: (track || '').trim() || null, time: starts[i].time, ...rc });
  }

  // enrich runners with career record + trainer/jockey from the detailed pages
  const detail = parseDetailedForm(text);
  for (const r of races) {
    for (const ru of r.runners) {
      const d = detail[normalizeName(ru.name)];
      if (d) {
        ru.careerStats = { starts: d.starts, wins: d.wins, seconds: d.seconds, thirds: d.thirds };
        if (!ru.jockey && d.jockey) ru.jockey = d.jockey;
        if (!ru.trainer && d.trainer) ru.trainer = d.trainer;
      }
    }
  }
  return { date, track: (track || '').trim() || null, races };
}

// Parse the detailed "form summary" lines: NAME S-W-2-3 %… Trainer NN% Jockey NN%
// Returns { normalizedName: { starts, wins, seconds, thirds, trainer, jockey } }.
function parseDetailedForm(text) {
  const out = {};
  const re = /([A-Z][A-Z0-9'’.\- ]{2,28}?)(\d+)-(\d+)-(\d+)-(\d+)\s*\d*%[\s\S]{0,70}?([A-Z][A-Za-z.'’ ]+?) \d+[�.]?\d*%([A-Z][A-Za-z.'’ ]+?) \d+[�.]?\d*%/g;
  let m;
  while ((m = re.exec(text))) {
    const key = normalizeName(m[1]);
    if (!key || out[key]) continue;
    out[key] = {
      starts: +m[2], wins: +m[3], seconds: +m[4],
      thirds: +String(m[5])[0], // 4th group can absorb the trailing place-% digit
      trainer: m[6].replace(/\s+/g, ' ').trim(),
      jockey: m[7].replace(/\s+/g, ' ').trim(),
    };
  }
  return out;
}

function parseRaceBlock(block, no) {
  const dist = block.match(/(\d{3,4})m\s*(TURF|POLYTRACK|POLY)/i);
  const distance = dist ? +dist[1] : null;
  const surface = dist ? (/POLY/i.test(dist[2]) ? 'Polytrack' : 'Turf') : null;

  // race title (between the time and the distance) → class label
  const title = (block.match(/\d{1,2}:\d{2}\s*-\s*([\s\S]*?)\d{3,4}m/) || [])[1] || '';
  const cls = classify(title);

  const hstart = block.search(/HORSE\s*-\s*NET\s*WGT|NO-\s*DR/i);
  const rend = block.search(/COMPUTAFORM RATINGS/i);
  const runnerText = block.slice(hstart >= 0 ? hstart : 0, rend >= 0 ? rend : block.length);
  const flat = runnerText.replace(/\s+/g, ' ').replace(/\s*\([A-Z]{2,3}\)/g, ''); // drop (IRE)/(AUS)

  // find runner starts, then the text between two starts holds comment + odds
  const rre = /(\d{1,2})\s*-\s*(\d{1,2})\s+([A-Z][A-Z0-9''‘’.\-\/ ]*?)\s+(\d{2}(?:\.\d)?)\s*(X{0,2})(?![\d])/g;
  const hits = [];
  let r;
  while ((r = rre.exec(flat))) {
    const name = r[3].replace(/\s+/g, ' ').trim();
    if (name.length < 2) continue;
    hits.push({ no: +r[1], draw: +r[2], name, weight: +r[4], gear: r[5] || '', end: rre.lastIndex });
  }
  const runners = hits.map((h, i) => {
    const tail = flat.slice(h.end, i + 1 < hits.length ? hits[i + 1].end - 0 : flat.length);
    const oddsMatches = tail.match(/(\d{1,3})\/(\d{1,3})/g) || [];
    const frac = oddsMatches.length ? oddsMatches[oddsMatches.length - 1] : null; // trailing F/B price
    let oddsDecimal = null;
    if (frac) { const [a, b] = frac.split('/').map(Number); if (b) oddsDecimal = +(a / b).toFixed(2); }
    return { no: h.no, draw: h.draw, name: h.name, weight: h.weight, gear: h.gear,
      oddsFrac: frac, oddsDecimal };
  });

  const ratingByNo = {};
  const cr = block.match(/COMPUTAFORM RATINGS([\s\S]*?)(SPEED RATINGS|$)/i);
  if (cr) {
    const rr = /(\d{1,2})\s+[A-Z][^\n\d]*?(\d{1,3})\s*(?:\n|$)/g;
    let x;
    while ((x = rr.exec(cr[1]))) ratingByNo[+x[1]] = +x[2];
  }
  runners.forEach((ru) => { if (ratingByNo[ru.no] != null) ru.rating = ratingByNo[ru.no]; });

  return { race: no, distance, surface, going: null,
    classLabel: cls.label, classType: cls.type, classRank: cls.rank, runners };
}

// Derive a concise class label + a comparable rank from a race title.
// rank: higher = better class (Grade 1 > Grade 3; MR 96 > MR 72). Movement
// direction is only compared within the same classType.
function classify(title) {
  const t = title.replace(/\s+/g, ' ').trim();
  const grade = t.match(/\(?\bGrade\s*(\d)\b\)?/i) || t.match(/\bGr\s*(\d)\b/i);
  if (grade) return { label: `Grade ${grade[1]}`, type: 'grade', rank: 100 - grade[1] * 5 };
  const mr = t.match(/\bMR\s*(\d{1,3})\b/i);
  if (mr) return { label: `MR ${mr[1]} Handicap`, type: 'mr', rank: +mr[1] };
  const named = t.match(/\b(Maiden(?:\s+Juvenile)?(?:\s+Plate)?|Juvenile\s+Plate|Novice\s+Plate|Graduation|Progress\s+Plate|Pinnacle\s+Stakes|Listed|Handicap|Plate|Stakes)\b/i);
  if (named) {
    const label = named[1].replace(/\s+/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    const rankMap = { maiden: 10, 'maiden plate': 10, 'maiden juvenile': 12, 'juvenile plate': 15, 'novice plate': 20, plate: 25, graduation: 30, 'progress plate': 35, handicap: 40, 'pinnacle stakes': 60, listed: 75, stakes: 55 };
    return { label, type: 'named', rank: rankMap[label.toLowerCase()] ?? null };
  }
  return { label: null, type: null, rank: null };
}

function num(v) { const n = Number(String(v ?? '').replace(/[^\d.\-]/g, '')); return Number.isFinite(n) && v != null && v !== '' ? n : null; }
function coerce(k, v) { return (k === 'race' || k === 'distance') ? num(v) : v.trim(); }

module.exports = { parseRacecard, normalizeRace, parseComputaform, classify };
