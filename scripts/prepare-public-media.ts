/**
 * Copies dataset media into `public/` so the browser can load it.
 *
 * Runs automatically before `next build` and `next dev`. The dataset directory
 * is the source of truth and stays untouched; `public/media` is generated and
 * git-ignored, which keeps the 11 MB of images and audio out of the repository
 * exactly once rather than twice.
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function main(): void {
  const source = join(process.cwd(), 'dataset', 'media');
  const destination = join(process.cwd(), 'public', 'media');

  if (!existsSync(source)) {
    console.warn('dataset/media not found — skipping media copy');
    return;
  }

  mkdirSync(join(process.cwd(), 'public'), { recursive: true });
  cpSync(source, destination, { recursive: true });
  console.log(`Copied dataset/media -> public/media`);
}

main();
