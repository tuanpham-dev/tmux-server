import type { Platform } from './types.ts';
import { posix } from './posix.ts';

export type { Platform } from './types.ts';

function pick(): Platform {
  if (process.platform === 'win32') {
    throw new Error('the terminal daemon does not run on Windows yet');
  }
  return posix;
}

export const platform: Platform = pick();
