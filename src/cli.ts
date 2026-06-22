#!/usr/bin/env node
// maven-code-graph CLI — project-scoped Maven dependency indexer

import { Command } from 'commander';
import { ensureIndexed } from './indexer/indexer.js';
import { searchNodes, getNodeByFQN, findImplementations, getMethods, getEdges, getStats } from './db/queries.js';
import { getClassSource } from './parser/source-parser.js';
import { detectProject } from './project/detector.js';
import { readState, isStale } from './project/state.js';
import type { ArtifactCoordinate, Artifact, Node, SearchResult } from './types.js';

const program = new Command();

program
  .name('mcg')
  .description('maven-code-graph — project-scoped Maven dependency indexer')
  .version('0.1.0');

// ============================================================
// init — index current project's dependencies
// ============================================================
program.command('init')
  .description('Index the current project\'s Maven dependencies')
  .action(async () => {
    const project = detectProject();
    if (!project) {
      process.stderr.write('No Maven/Gradle project found. Run from a project directory.\n');
      process.exit(1);
    }

    process.stderr.write(`Project: ${project.root}\n`);
    process.stderr.write(`Build: ${project.buildSystem} (${project.buildFile})\n`);
    process.stderr.write('Resolving dependencies...\n');

    const result = await ensureIndexed();
    if (!result) {
      process.stderr.write('Failed to index.\n');
      process.exit(1);
    }

    const stats = getStats();
    process.stderr.write(`Done. ${result.deps.length} dependencies, ${stats.totalNodes} classes indexed.\n`);
  });

// ============================================================
// search — full-text search for classes in project dependencies
// ============================================================
program.command('search')
  .description('Search for classes in project dependencies')
  .argument('<query>', 'class name or keyword')
  .option('-l, --limit <n>', 'max results', '20')
  .option('-a, --all', 'search all indexed artifacts (ignore project scope)')
  .action(async (query: string, opts: { limit: string; all?: boolean }) => {
    const limit = parseInt(opts.limit) || 20;
    let deps: ArtifactCoordinate[] | undefined;

    if (!opts.all) {
      const result = await ensureIndexed();
      if (result) deps = result.deps;
    }

    const results = searchNodes(query, deps, limit);

    if (results.length === 0) {
      process.stdout.write('No classes found.\n');
      return;
    }

    for (const r of results) {
      process.stdout.write(`${r.node.name}  [${r.node.kind}]\n`);
      process.stdout.write(`  ${r.artifact.groupId}:${r.artifact.artifactId}:${r.artifact.version}\n`);
      process.stdout.write('\n');
    }
  });

// ============================================================
// class — get class details (source, docs, or signatures)
// ============================================================
program.command('class')
  .description('Get class details from dependency JARs')
  .argument('<className>', 'fully qualified class name')
  .option('-t, --type <type>', 'output type: source, docs, or signatures', 'signatures')
  .option('-c, --coordinate <gav>', 'exact Maven coordinate (groupId:artifactId:version)')
  .action(async (className: string, opts: { type: string; coordinate?: string }) => {
    const validTypes = ['signatures', 'docs', 'source'];
    if (!validTypes.includes(opts.type)) {
      process.stderr.write(`Invalid type: ${opts.type}. Must be one of: ${validTypes.join(', ')}\n`);
      process.exit(1);
    }

    let node: (Node & { artifact: Artifact }) | null = null;

    if (opts.coordinate) {
      // Exact coordinate lookup — bypass project scope
      const [g, a, v] = opts.coordinate.split(':');
      if (!g || !a || !v) {
        process.stderr.write('Invalid coordinate. Use groupId:artifactId:version\n');
        process.exit(1);
      }
      const { findArtifact } = await import('./db/queries.js');
      const artifact = findArtifact({ groupId: g, artifactId: a, version: v });
      if (!artifact) {
        process.stderr.write(`Artifact not indexed: ${opts.coordinate}\n`);
        process.exit(1);
      }
      // Search within this specific artifact
      const results = searchNodes(className, [{ groupId: g, artifactId: a, version: v }], 1);
      if (results.length > 0) {
        node = { ...results[0].node, artifact: results[0].artifact };
      }
    } else {
      const deps = (await ensureIndexed())?.deps;
      node = getNodeByFQN(className, deps);
    }

    if (!node) {
      process.stderr.write(`Class not found: ${className}\n`);
      process.exit(1);
    }

    const art = node.artifact;
    process.stderr.write(`Resolved: ${art.groupId}:${art.artifactId}:${art.version}\n`);

    const source = await getClassSource(art.jarPath, art.hasSource, className, opts.type as any);
    if (!source) {
      process.stderr.write('Could not extract source/signatures.\n');
      process.exit(1);
    }

    if (source.usedDecompilation) {
      process.stderr.write('(Fernflower decompiled — may differ from original source)\n\n');
    }

    if (opts.type === 'source' && source.source) {
      process.stdout.write(source.source);
    } else if (source.signatures) {
      process.stdout.write(source.signatures.join('\n'));
    }
    if (source.doc) {
      process.stdout.write('\n\n' + source.doc);
    }
    process.stdout.write('\n');
  });

// ============================================================
// implementations — find implementations of an interface/class
// ============================================================
program.command('implementations')
  .description('Find implementations/subclasses of an interface or abstract class')
  .argument('<className>', 'fully qualified class/interface name')
  .option('-a, --all', 'search all indexed artifacts')
  .action(async (className: string, opts: { all?: boolean }) => {
    let deps: ArtifactCoordinate[] | undefined;
    if (!opts.all) {
      deps = (await ensureIndexed())?.deps;
    }

    const impls = findImplementations(className, deps);
    if (impls.length === 0) {
      process.stdout.write(`No implementations found for: ${className}\n`);
      return;
    }

    for (const n of impls) {
      process.stdout.write(`${n.name}  [${n.kind}]\n`);
    }
  });

// ============================================================
// status — show index status
// ============================================================
program.command('status')
  .description('Show index status for the current project')
  .action(() => {
    const stats = getStats();
    process.stdout.write(`Global artifact cache:\n`);
    process.stdout.write(`  Artifacts: ${stats.totalArtifacts}\n`);
    process.stdout.write(`  Classes:   ${stats.totalNodes}\n`);
    process.stdout.write(`  Edges:     ${stats.totalEdges}\n`);
    process.stdout.write(`  Methods:   ${stats.totalMethods}\n`);

    const project = detectProject();
    if (project) {
      const state = readState(project.buildFile);
      if (state) {
        const stale = isStale(project, state);
        process.stdout.write(`\nModule: ${project.buildFile}\n`);
        process.stdout.write(`  Dependencies: ${state.dependencies.length}\n`);
        process.stdout.write(`  Status: ${stale ? 'STALE (re-run init)' : 'up to date'}\n`);
        process.stdout.write(`  Last indexed: ${new Date(state.lastIndexedAt).toISOString()}\n`);
      } else {
        process.stdout.write(`\nModule: ${project.buildFile}\n`);
        process.stdout.write(`  Status: not indexed (run 'mcg init')\n`);
      }
    }
  });

program.parse();
