'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeName } = require('./names');

// Parse a racecard into a normalized race object:
// { date, track, race, distance, going, runners: [{ no, name, draw, weight, rating, jockey, trainer }] }
//
// Three input modes, tried by extension:
//   .json  -> already-structured race (fastest, most reliable)
//   .txt   -> pipe/tab/CSV rows or raw text (parsed heuristically)
//   .pdf   -> TAB Computaform PDF; text extracted via pdf-parse (optional dep)
//
// TAB Computaform PDFs vary; the PDF path extracts text and applies
// heuristics, and ALWAYS writes what it could not confidently parse so you
// can correct it rather than getting a silent wrong field.

async function parseRacecard(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') return normalizeRace(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (ext === '.txt' || ext === '.csv') return parseText(fs.readFileSync(file, 'utf8'), file);
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
    jockey: x.jockey ?? null,
    trainer: x.trainer ?? null,
  })).filter((x) => x.name);
  r.race = r.race ?? r.raceNo ?? 1;
  r.distance = r.distance ?? null;
  r.going = r.going ?? null;
  r.track = r.track ?? null;
  r.date = r.date ?? new Date().toISOString().slice(0, 10);
  return r;
}

// TXT/CSV: header line "date,track,race,distance,going" then one runner per row:
// no,name,draw,weight,rating,jockey,trainer  (missing cols ok)
function parseText(text, file) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const meta = { race: 1 };
  const runners = [];
  for (const line of lines) {
    if (/^#/.test(line)) continue;
    const kv = line.match(/^(date|track|race|distance|going)\s*[:=]\s*(.+)$/i);
    if (kv) { meta[kv[1].toLowerCase()] = coerce(kv[1].toLowerCase(), kv[2]); continue; }
    const cols = line.split(/\s*[|\t,]\s*/);
    if (cols.length >= 2 && /\d/.test(cols[0]) === false && cols[0].toLowerCase() === 'no') continue;
    if (cols.length >= 2) {
      runners.push({
        no: num(cols[0]), name: cols[1], draw: num(cols[2]),
        weight: num(cols[3]), rating: num(cols[4]),
        jockey: cols[5] || null, trainer: cols[6] || null,
      });
    }
  }
  if (!runners.length) throw new Error(`No runners parsed from ${path.basename(file)}`);
  return normalizeRace({ ...meta, runners });
}

async function parsePdf(file) {
  let pdfParse;
  try { pdfParse = require('pdf-parse'); }
  catch {
    throw new Error(
      'PDF parsing needs the optional "pdf-parse" package.\n' +
      '  Run: npm install pdf-parse\n' +
      '  Or convert the racecard to .json/.txt (see data/racecards/EXAMPLE.txt).'
    );
  }
  const buf = fs.readFileSync(file);
  const { text } = await pdfParse(buf);
  const race = heuristicPdf(text);

  // Persist a review artifact so nothing parses silently-wrong.
  const reviewDir = path.resolve(__dirname, '..', '..', 'data', 'review');
  fs.mkdirSync(reviewDir, { recursive: true });
  const stub = path.join(reviewDir, path.basename(file, '.pdf') + '.parsed.json');
  fs.writeFileSync(stub, JSON.stringify(race, null, 2) + '\n');
  race._review = stub;
  return race;
}

// Heuristic extraction from Computaform text. Looks for a distance token,
// a track name, and runner rows starting with a saddle-cloth number.
function heuristicPdf(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const joined = text.replace(/\s+/g, ' ');
  const distance = (joined.match(/(\d{3,4})\s?m\b/) || [])[1];
  const track = (joined.match(/\b(Turffontein|Vaal|Fairview|Scottsville|Greyville)\b/i) || [])[1];
  const going = (joined.match(/\b(Good(?:\s?to\s?(?:Firm|Soft))?|Soft|Yielding|Heavy|Standard|Firm|Poly(?:track)?)\b/i) || [])[1];
  const dateM = joined.match(/(\d{1,2})[\/\-\s](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{1,2})[\/\-\s](\d{2,4})/i);

  const runners = [];
  for (const line of lines) {
    // e.g. "3  EL BARB  (5)  60.0  J Smith  A Trainer  92"
    const m = line.match(/^(\d{1,2})[.\)]?\s+([A-Z][A-Za-z'’\- ]{2,30}?)\s{2,}/);
    if (m) {
      const no = Number(m[1]);
      const name = m[2].trim();
      const draw = (line.match(/\((\d{1,2})\)/) || [])[1];
      const weight = (line.match(/\b(\d{2}(?:\.\d)?)\s?kg?\b/) || line.match(/\s(\d{2}\.\d)\s/) || [])[1];
      const rating = (line.match(/\b(\d{2,3})\s*$/) || [])[1];
      if (no >= 1 && no <= 30 && name.length >= 3) {
        runners.push({ no, name, draw: num(draw), weight: num(weight), rating: num(rating), jockey: null, trainer: null });
      }
    }
  }

  return normalizeRace({
    date: dateM ? toISO(dateM) : new Date().toISOString().slice(0, 10),
    track: track || null,
    race: Number((joined.match(/Race\s+(\d{1,2})/i) || [])[1]) || 1,
    distance: distance ? Number(distance) : null,
    going: going || null,
    runners,
  });
}

function toISO(m) {
  const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  let [_, d, mo, y] = m;
  d = String(d).padStart(2, '0');
  mo = isNaN(+mo) ? months[String(mo).toLowerCase().slice(0, 3)] : String(mo).padStart(2, '0');
  if (y.length === 2) y = '20' + y;
  return `${y}-${mo}-${d}`;
}

function num(v) { const n = Number(String(v ?? '').replace(/[^\d.\-]/g, '')); return Number.isFinite(n) && v != null && v !== '' ? n : null; }
function coerce(k, v) { return (k === 'race' || k === 'distance') ? num(v) : v.trim(); }

module.exports = { parseRacecard, normalizeRace };
