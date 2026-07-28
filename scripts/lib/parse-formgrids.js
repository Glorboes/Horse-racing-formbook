'use strict';
// Parse Formgrids two-line "racecard/results" web text into races of finishers.
// Line A: [«] [prevcodes] <no> <HORSE> [Below form] Add horse to watchlist ... View collateral <JOCKEY>
// Line B: <TRAINER> <age> <sex> [MR] <Equip...> <Wgh> <Dr[going][%]> ... <Fin> <LBH> <Time> <OP> <SP> [post]

function fractionToDecimal(s) {
  const m = String(s || '').match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (!m) return null; const b = +m[2]; return b > 0 ? +(+m[1] / b + 1).toFixed(3) : null;
}

function parseLineA(line) {
  const parts = line.split(/Add horse to watchlist.*?View collateral/i);
  const left = (parts[0] || '').replace(/^«\s*/, '').replace(/\s*Below form\s*/gi, ' ').trim();
  const jockey = (parts[1] || '').trim();
  const m = left.match(/(?:^|\s)(\d{1,2})\s+([A-Z][A-Z0-9'’.()\/\- ]+?)\s*$/);
  let no = null, name = null;
  if (m) { no = +m[1]; name = m[2].trim(); }
  else { const m2 = left.match(/([A-Z][A-Z0-9'’.()\/\- ]+)\s*$/); if (m2) name = m2[1].trim(); }
  if (name) name = name.replace(/\s+[A-Z]$/, '').trim(); // drop trailing gear code (e.g. " L")
  return { no, name, jockey: jockey || null };
}

function parseLineB(line) {
  const s = line.replace(/ /g, ' ').replace(/\t/g, ' ').replace(/ +/g, ' ').trim();
  let fin = null, lbh = null, sp = null, oddsDecimal = null, headEnd = -1;
  let t = s.match(/(\d+)\s+(-?\d+(?:\.\d+)?|99)\s+(\d+(?:\.\d+)?)\s+(\d+\/\d+)\s+(\d+\/\d+)(?:\s|$)/);
  if (t) { fin = +t[1]; lbh = parseFloat(t[2]); sp = t[5]; oddsDecimal = fractionToDecimal(t[5]); headEnd = t.index; }
  else {
    t = s.match(/(\d+)\s+(-?\d+(?:\.\d+)?|99)\s+(\d+(?:\.\d+)?)\s*$/);
    if (!t) return null;
    fin = +t[1]; lbh = parseFloat(t[2]); headEnd = t.index;
  }
  const head = s.slice(0, headEnd).trim();
  const hm = head.match(/^(.+?)\s+(\d)\s+([cfghmr])\b\s*(.*)$/i);
  let trainer = null, rating = null, weight = null, draw = null;
  if (hm) {
    trainer = hm[1].trim();
    let rest = hm[4].trim();
    const mm = rest.match(/^(\d{2,3})\s+(.*)$/);
    if (mm) { rating = +mm[1]; rest = mm[2]; }
    const toks = rest.split(' ');
    const wtok = toks.find((x) => /^\d{2}\.\d$/.test(x)) || toks.find((x) => /^\d{2}$/.test(x));
    if (wtok) {
      weight = parseFloat(wtok);
      const after = rest.slice(rest.indexOf(wtok) + wtok.length).trim();
      const dm = after.match(/^(\d{1,2})/); if (dm) draw = +dm[1];
    }
  }
  return { trainer, rating, weight, draw, finish: fin, lbh, sp, oddsDecimal };
}

function parseMeeting(text) {
  const lines = text.split(/\r?\n/);
  const races = []; let cur = null, pending = null;
  const flush = () => { if (cur && cur.rows.length) races.push(cur); };
  for (const raw of lines) {
    const line = raw.replace(/[\t ]/g, ' ').trim();
    if (!line) continue;
    if (/^Race\s+\d+/i.test(line)) { flush(); cur = { rows: [] }; pending = null; if (!/Previous Races/i.test(line)) continue; }
    if (/Previous Races/i.test(line)) { if (!cur) cur = { rows: [] }; continue; }
    if (/Race results/i.test(line) && !/Add horse/i.test(line)) continue;
    if (!cur) cur = { rows: [] };
    if (/Add horse to watchlist/i.test(line)) pending = parseLineA(line);
    else if (pending) { const b = parseLineB(line); if (b) cur.rows.push({ ...pending, ...b }); pending = null; }
  }
  flush();
  return races.map((r, i) => {
    const rows = r.rows.filter((x) => x.name && Number.isFinite(x.finish)).sort((a, b) => a.finish - b.finish);
    const finishers = rows.map((row, j) => {
      let gap = j === 0 ? 0 : Math.max(0, row.lbh - rows[j - 1].lbh);
      if (!isFinite(gap) || gap > 25 || row.lbh >= 99) gap = j === 0 ? 0 : 25;
      return { name: row.name, finish: row.finish, marginLengths: +gap.toFixed(2), jockey: row.jockey,
        trainer: row.trainer, weight: row.weight, draw: row.draw, rating: row.rating, sp: row.sp, oddsDecimal: row.oddsDecimal };
    });
    return { race: i + 1, finishers };
  });
}

module.exports = { parseMeeting };
