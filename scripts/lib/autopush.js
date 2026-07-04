'use strict';

const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

// git add/commit/push the updated JSON + dashboard so the phone view stays
// current. No-ops cleanly if there is nothing to commit or no git remote.
// Disable with AUTO_PUSH=0 (e.g. in CI or offline).
function autoPush(message) {
  if (process.env.AUTO_PUSH === '0') {
    console.log('• auto-push disabled (AUTO_PUSH=0)');
    return { pushed: false, reason: 'disabled' };
  }
  const run = (cmd) => execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  try {
    run('git rev-parse --is-inside-work-tree');
  } catch {
    console.log('• not a git repo — skipping auto-push');
    return { pushed: false, reason: 'no-git' };
  }
  try {
    run('git add -A data docs');
    const status = run('git status --porcelain');
    if (!status) {
      console.log('• nothing changed — skipping commit');
      return { pushed: false, reason: 'clean' };
    }
    run(`git commit -m ${JSON.stringify(message)}`);
    let branch = 'HEAD';
    try { branch = run('git rev-parse --abbrev-ref HEAD'); } catch {}
    let pushed = false;
    for (const [i, delay] of [0, 2000, 4000, 8000, 16000].entries()) {
      try {
        if (delay) execSync(`sleep ${delay / 1000}`);
        run(`git push -u origin ${branch}`);
        pushed = true;
        break;
      } catch (e) {
        console.log(`• push attempt ${i + 1} failed${delay ? `, retrying in ${delay / 1000}s` : ''}`);
      }
    }
    if (pushed) console.log(`✓ pushed to origin/${branch}`);
    else console.log('• commit made locally but push failed — run `git push` manually');
    return { pushed, committed: true, branch };
  } catch (e) {
    console.log('• auto-push error:', e.message.split('\n')[0]);
    return { pushed: false, error: e.message };
  }
}

module.exports = { autoPush };
