// Indexer: orchestrates project dependency indexing.
//   - Uses diffDependencies for incremental indexing (new/changed deps only).
//   - Processes JARs in parallel with concurrency control.
//   - hasSource → tree-sitter AST parsing.
//   - !hasSource → bytecode parsing (class names + method signatures).
//   - Fernflower decompilation is deferred to query time.

import { cpus } from 'os';
import type { ArtifactCoordinate, ProjectState } from '../types.js';
import { resolveDependencies } from '../dependency/resolver.js';
import { scanSourceJar, scanClassJar } from '../parser/jar-scanner.js';
import { upsertArtifact, isArtifactIndexed } from '../db/queries.js';
import { detectProject, hashFile, type ProjectInfo } from '../project/detector.js';
import { readState, writeState, isStale, diffDependencies } from '../project/state.js';
import { createHash } from 'crypto';
import { statSync } from 'fs';

const DEFAULT_CONCURRENCY = Math.max(2, cpus().length);

/** Ensure the current project's dependencies are indexed. */
export async function ensureIndexed(): Promise<{ project: ProjectInfo; deps: ArtifactCoordinate[] } | null> {
  const project = detectProject();
  if (!project) return null;

  const state = readState(project.buildFile);

  if (!isStale(project, state)) {
    return { project, deps: state!.dependencies };
  }

  return { project, deps: await fullIndex(project, state) };
}

/** Full or incremental index. */
async function fullIndex(project: ProjectInfo, oldState: ProjectState | null): Promise<ArtifactCoordinate[]> {
  const resolved = await resolveDependencies(project);
  process.stderr.write(`Resolved ${resolved.length} dependencies.\n`);

  // Diff: only process new or version-changed deps
  const oldDeps = oldState?.dependencies || [];
  const toProcess = diffDependencies(oldDeps, resolved.map(d => ({
    groupId: d.groupId, artifactId: d.artifactId, version: d.version,
  })));

  const unchanged = resolved.length - toProcess.length;
  if (unchanged > 0) {
    process.stderr.write(`${unchanged} deps unchanged, ${toProcess.length} to index.\n`);
  }

  // Resolve ResolvedDependency objects for the ones we need to process
  const processSet = new Set(toProcess.map(d => `${d.groupId}:${d.artifactId}:${d.version}`));
  const toIndex = resolved.filter(d =>
    processSet.has(`${d.groupId}:${d.artifactId}:${d.version}`)
  );

  // Process in parallel batches
  const concurrency = parseInt(process.env.MCG_CONCURRENCY || '') || DEFAULT_CONCURRENCY;
  await processBatch(toIndex, concurrency);

  // Build coordinate list from ALL dependencies (old unchanged + newly processed)
  const coordinates: ArtifactCoordinate[] = resolved.map(d => ({
    groupId: d.groupId, artifactId: d.artifactId, version: d.version,
  }));

  // Write state
  const newState: ProjectState = {
    projectRoot: project.root,
    pomHash: hashFile(project.buildFile),
    dependencies: coordinates,
    lastIndexedAt: Date.now(),
  };
  writeState(project.buildFile, newState);

  return coordinates;
}

// ---- Parallel batch processing ----

async function processBatch(
  deps: { groupId: string; artifactId: string; version: string; jarPath: string; hasSource: boolean }[],
  concurrency: number,
): Promise<void> {
  if (deps.length === 0) return;

  let totalClasses = 0;
  let totalMethods = 0;
  let skipped = 0;
  let errors = 0;
  let completed = 0;

  const queue = deps.map((dep, idx) => ({ dep, idx, total: deps.length }));

  const worker = async () => {
    while (queue.length > 0) {
      const task = queue.shift()!;
      const { dep } = task;

      // Compute content hash
      let contentHash = '';
      try {
        const stat = statSync(dep.jarPath);
        contentHash = createHash('sha256').update(`${stat.mtimeMs}:${stat.size}`).digest('hex');
      } catch {
        // Jar missing, skip
        completed++;
        continue;
      }

      const artifactId = upsertArtifact(
        { groupId: dep.groupId, artifactId: dep.artifactId, version: dep.version },
        dep.jarPath, dep.hasSource, contentHash,
      );

      if (isArtifactIndexed(artifactId)) {
        skipped++;
        completed++;
        continue;
      }

      try {
        const result = dep.hasSource
          ? await scanSourceJar(artifactId, dep.jarPath.replace(/\.jar$/, '-sources.jar'))
          : await scanClassJar(artifactId, dep.jarPath);

        totalClasses += result.classesIndexed;
        totalMethods += result.methodsIndexed;
        errors += result.errors.length;
      } catch (e: any) {
        errors++;
        process.stderr.write(`  Failed ${dep.groupId}:${dep.artifactId}: ${e.message}\n`);
      }

      completed++;
      if (completed % 10 === 0 || completed === deps.length) {
        process.stderr.write(`  [${completed}/${deps.length}] ${totalClasses} classes, ${totalMethods} methods\n`);
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, deps.length) }, () => worker());
  await Promise.all(workers);

  if (skipped > 0) {
    process.stderr.write(`Skipped ${skipped} already indexed.\n`);
  }
  if (errors > 0) {
    process.stderr.write(`${errors} errors during indexing.\n`);
  }
}
