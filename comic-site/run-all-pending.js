// Runs all pending upload scripts sequentially with retry logic
const { spawnSync } = require('child_process');

const scripts = [
  'upload-volcanic-age.js',
  'upload-murim-login.js',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runScript(script) {
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Running: ${script} (attempt ${attempt})`);
    console.log('='.repeat(60));

    const result = spawnSync('node', [script], { stdio: 'inherit', encoding: 'utf8' });

    if (result.status === 0) {
      console.log(`\n✓ ${script} completed successfully.`);
      return;
    }

    if (attempt < maxAttempts) {
      const waitSec = 20 * attempt;
      console.log(`\nFailed (exit ${result.status}). Waiting ${waitSec}s before retry...`);
      await sleep(waitSec * 1000);
    } else {
      console.log(`\n✗ ${script} failed after ${attempt} attempts.`);
      return;
    }
  }
}

async function main() {
  for (const script of scripts) {
    await runScript(script);
    // Brief pause between scripts to let connections fully close
    await sleep(5000);
  }
  console.log('\n\nAll scripts finished.');
}

main();
