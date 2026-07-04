'use strict';

// Minimal end-to-end sanity check of the engine (no network, no git).
const assert = require('assert');
const fb = require('./formbook');
const { scoreRace } = require('./scoring');
const { strongestByHeadToHead } = require('./formbook');

function run() {
  const book = { meta: {}, horses: {}, headToHead: {}, predictionsLog: [] };

  // two historical races involving overlapping horses
  fb.logResult(book, {
    date: '2026-05-01', track: 'Turffontein', race: 3, distance: 1600, going: 'Good',
    finishers: [
      { name: 'El Barb', finish: 1, marginLengths: 0 },
      { name: 'Silver Host', finish: 2, marginLengths: 1.5 },
      { name: 'Night Watch', finish: 3, marginLengths: 1.0 },
    ],
  });
  fb.logResult(book, {
    date: '2026-06-14', track: 'Vaal', race: 5, distance: 1600, going: 'Good',
    finishers: [
      { name: 'Silver Host', finish: 1, marginLengths: 0 },
      { name: 'El Barb', finish: 2, marginLengths: 0.25 },
      { name: 'Cape Venture', finish: 3, marginLengths: 3.0 },
    ],
  });

  // head-to-head recorded both ways, order-independent
  assert(book.headToHead['EL BARB|SILVER HOST'], 'H2H pair key exists');
  assert.strictEqual(book.headToHead['EL BARB|SILVER HOST'].length, 2, 'two meetings El Barb vs Silver Host');

  // strongest-by-h2h over a field
  const field = ['El Barb', 'Silver Host', 'Night Watch', 'Cape Venture'];
  const strongest = strongestByHeadToHead(book, field);
  assert(strongest[0].meetings > 0, 'leader has recorded meetings');
  console.log('  strongest:', strongest.map((s) => `${s.name}(${s.record})`).join(' > '));

  // full race scoring produces ranked reasoning
  const { ranked, h2h } = scoreRace(book, {
    date: '2026-07-05', track: 'Turffontein', race: 5, distance: 1600, going: 'Good',
    runners: field.map((name, i) => ({ no: i + 1, name, draw: i + 1, weight: 60 - i, rating: 96 - i * 4 })),
  });
  assert.strictEqual(ranked.length, 4, 'four ranked runners');
  assert(ranked[0].reasoning.length > 0, 'reasoning present');
  assert(h2h.length === 4, 'h2h table sized to field');

  console.log('  top pick:', ranked[0].name, ranked[0].score, '|', ranked[0].reasoning[0]);
  console.log('✓ selftest passed');
}

run();
