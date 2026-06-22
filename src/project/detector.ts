// Project detection: find Maven project root from cwd

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export type BuildSystem = 'maven';

export interface ProjectInfo {
  root: string;
  moduleDir: string;
  buildSystem: BuildSystem;
  buildFile: string;       // absolute path to pom.xml
}

/** Walk up from cwd to find the nearest pom.xml */
export function detectProject(cwd: string = process.cwd()): ProjectInfo | null {
  let dir = path.resolve(cwd);

  while (true) {
    const pomPath = path.join(dir, 'pom.xml');
    if (fs.existsSync(pomPath)) {
      return { root: dir, moduleDir: dir, buildSystem: 'maven', buildFile: pomPath };
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

/** Compute SHA-256 hash of a file */
export function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}
