/**
 * Builds `code.zip` for submission.
 *
 *   npm run package              # excludes .env.local (default)
 *   npm run package -- --with-env  # bundles .env.local as well
 *
 * Environment files are excluded by default and only included when explicitly
 * asked for. Bundling live credentials is occasionally a deliberate choice —
 * short-lived keys the author intends to revoke, handed to a reviewer who needs
 * the integrations working — but it should never be something that happens by
 * accident because someone ran the default command.
 *
 * The script prints exactly what it bundled, so what reached the archive is
 * visible rather than assumed.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Directories and files never worth shipping. */
const ALWAYS_EXCLUDE = [
  'node_modules/*',
  '.next/*',
  'coverage/*',
  'public/media/*', // regenerated from dataset/media by the prebuild step
  '.git/*',
  '*.tsbuildinfo',
  '.DS_Store',
  '.vercel/*',
];

const ENV_PATTERNS = ['.env.local', '.env*.local', '.env'];

function main(): void {
  const withEnv = process.argv.includes('--with-env');
  const output = join(process.cwd(), 'code.zip');

  if (existsSync(output)) rmSync(output);

  const excludes = [...ALWAYS_EXCLUDE, ...(withEnv ? [] : ENV_PATTERNS)];
  const args = ['-r', '-q', output, '.', '-x', ...excludes];

  execFileSync('zip', args, { cwd: process.cwd(), stdio: 'inherit' });

  const listing = execFileSync('unzip', ['-Z1', output], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

  const sizeMb = statSync(output).size / (1024 * 1024);

  console.log(`\ncode.zip — ${listing.length} files, ${sizeMb.toFixed(1)} MB`);

  const bundledEnv = listing.filter((name) => /(^|\/)\.env/.test(name) && !name.endsWith('.example'));
  if (bundledEnv.length > 0) {
    console.log(`\n  Bundled environment files (contain live credentials):`);
    for (const name of bundledEnv) console.log(`    ${name}`);
    console.log(`  Revoke these keys once the submission has been assessed.`);
  } else {
    console.log(`\n  No environment files bundled. .env.example documents what is needed.`);
  }

  const hasDataset = listing.some((name) => name.startsWith('dataset/'));
  const hasOutput = listing.includes('output.csv');
  console.log(`\n  dataset/ included: ${hasDataset}`);
  console.log(`  output.csv included: ${hasOutput}`);
}

main();
