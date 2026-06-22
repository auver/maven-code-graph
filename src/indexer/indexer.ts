// Indexer: orchestrates project dependency indexing

import type { ArtifactCoordinate, ProjectState } from '../types.js';
import { resolveDependencies } from '../dependency/resolver.js';
import { scanSourceJar, ensureSourceJar } from '../parser/jar-scanner.js';
import { upsertArtifact, isArtifactIndexed } from '../db/queries.js';
import { detectProject, hashFile, type ProjectInfo } from '../project/detector.js';
import { readState, writeState, isStale } from '../project/state.js';
import { statSync } from 'fs';
import { createHash } from 'crypto';

/** Ensure the current project's dependencies are indexed. Returns project info + deps. */
export async function ensureIndexed(): Promise<{ project: ProjectInfo; deps: ArtifactCoordinate[] } | null> {
  const project = detectProject();
  if (!project) return null;

  const state = readState(project.buildFile);

  if (!isStale(project, state)) {
    return { project, deps: state!.dependencies };
  }

  return { project, deps: await fullIndex(project, state) };
}

/** Full index: resolve deps, acquire source jars, parse + index */
async function fullIndex(project: ProjectInfo, oldState: ProjectState | null): Promise<ArtifactCoordinate[]> {
  const resolved = await resolveDependencies(project);

  const coordinates: ArtifactCoordinate[] = [];
  let totalClasses = 0;
  let totalMethods = 0;
  let skipped = 0;
  let errors = 0;

  for (const dep of resolved) {
    const coord: ArtifactCoordinate = { groupId: dep.groupId, artifactId: dep.artifactId, version: dep.version };

    let contentHash = '';
    try {
      const stat = statSync(dep.jarPath);
      contentHash = createHash('sha256').update(`${stat.mtimeMs}:${stat.size}`).digest('hex');
    } catch {}

    const artifactId = upsertArtifact(coord, dep.jarPath, dep.hasSource, contentHash);

    if (!isArtifactIndexed(artifactId)) {
      try {
        const sourceJar = await ensureSourceJar(dep.jarPath, dep.hasSource);
        const result = await scanSourceJar(artifactId, sourceJar);
        totalClasses += result.classesIndexed;
        totalMethods += result.methodsIndexed;
        errors += result.errors.length;
      } catch (e: any) {
        errors++;
        process.stderr.write(`  Decompile failed for ${coord.groupId}:${coord.artifactId}: ${e.message}\n`);
      }
    } else {
      skipped++;
    }

    coordinates.push(coord);
  }

  const total = resolved.length;
  process.stderr.write(`Indexed ${totalClasses} classes, ${totalMethods} methods across ${total} artifacts (${skipped} already indexed, ${errors} errors)\n`);

  const newState: ProjectState = {
    projectRoot: project.root,
    pomHash: hashFile(project.buildFile),
    dependencies: coordinates,
    lastIndexedAt: Date.now(),
  };
  writeState(project.buildFile, newState);

  return coordinates;
}
