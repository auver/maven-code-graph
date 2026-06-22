// Project state management: read/write .maven-codegraph/state.json
// Each pom.xml gets its own state — a submodule's state is independent from the root's.

import fs from 'fs';
import path from 'path';
import type { ProjectState, ArtifactCoordinate } from '../types.js';
import { hashFile, type ProjectInfo } from './detector.js';

const STATE_DIR = '.maven-codegraph';
const STATE_FILE = 'state.json';

/** Get the state file path for a given pom.xml */
function statePathFor(buildFile: string): string {
  // Store state alongside the pom.xml, not at project root
  // basic/rpc/pom.xml → basic/rpc/.maven-codegraph/state.json
  return path.join(path.dirname(buildFile), STATE_DIR, STATE_FILE);
}

/** Read state for the pom.xml. Returns null if not initialized. */
export function readState(buildFile: string): ProjectState | null {
  try {
    const data = fs.readFileSync(statePathFor(buildFile), 'utf-8');
    return JSON.parse(data) as ProjectState;
  } catch {
    return null;
  }
}

/** Write state for the pom.xml */
export function writeState(buildFile: string, state: ProjectState): void {
  const dir = path.dirname(statePathFor(buildFile));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(statePathFor(buildFile), JSON.stringify(state, null, 2), 'utf-8');
}

/** Check if the pom.xml's state is stale */
export function isStale(project: ProjectInfo, state: ProjectState | null): boolean {
  if (!state) return true;
  const currentHash = hashFile(project.buildFile);
  return currentHash !== state.pomHash;
}

/** Compare two dependency lists, return newly added or version-changed deps */
export function diffDependencies(
  oldDeps: ArtifactCoordinate[],
  newDeps: ArtifactCoordinate[]
): ArtifactCoordinate[] {
  const oldMap = new Map<string, string>();
  for (const d of oldDeps) {
    oldMap.set(`${d.groupId}:${d.artifactId}`, d.version);
  }

  const added: ArtifactCoordinate[] = [];
  for (const d of newDeps) {
    const key = `${d.groupId}:${d.artifactId}`;
    const oldVersion = oldMap.get(key);
    if (!oldVersion || oldVersion !== d.version) {
      added.push(d);
    }
  }
  return added;
}
