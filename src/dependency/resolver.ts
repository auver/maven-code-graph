// Maven dependency resolution: runs mvn to resolve exact dependencies

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import type { ResolvedDependency } from '../types.js';
import type { ProjectInfo } from '../project/detector.js';

const execAsync = promisify(exec);

/** Standard Maven local repository path */
const M2_REPO = process.env.MAVEN_REPO_PATH ||
  (process.env.HOME ? path.join(process.env.HOME, '.m2', 'repository') : '/tmp/.m2/repository');

/**
 * Resolve the project's Maven dependencies via `mvn dependency:build-classpath`.
 * Uses -f <pom.xml> to scope exactly to the detected pom.xml (handles submodules).
 * Returns exact G:A:V:jarPath for each dependency.
 */
export async function resolveDependencies(project: ProjectInfo): Promise<ResolvedDependency[]> {
  try {
    const { stdout } = await execAsync(
      `mvn -f "${project.buildFile}" dependency:build-classpath -q -DincludeScope=compile -Dmdep.outputFile=/dev/stdout`,
      { cwd: project.moduleDir, timeout: 120000, maxBuffer: 10 * 1024 * 1024 }
    );

    // Extract all .jar paths from the classpath string.
    // Use regex instead of split(':') because mvn occasionally omits colons
    // between paths (multi-module reactor edge case).
    const jarPaths = (stdout.match(/\/[^\s:]*?\.jar/g) || [])
      .filter((p, i, arr) => arr.indexOf(p) === i); // deduplicate
    return jarPaths.map(jarPath => parseGAVFromPath(jarPath)).filter((d): d is ResolvedDependency => d !== null);
  } catch (e: any) {
    return resolveFromPomXml(project.buildFile);
  }
}

/** Parse groupId:artifactId:version from a Maven repository JAR path */
function parseGAVFromPath(jarPath: string): ResolvedDependency | null {
  // Path format: .../groupId/dirs/artifactId/version/artifactId-version.jar
  const parts = jarPath.split('/');
  const fileName = parts[parts.length - 1];
  const version = parts[parts.length - 2];
  const artifactId = parts[parts.length - 3];

  // Reconstruct groupId from the remaining path (relative to repository root)
  // Find where in the path the groupId starts
  const m2Index = parts.findIndex(p => p === 'repository');
  const groupParts: string[] = [];
  if (m2Index >= 0) {
    for (let i = m2Index + 1; i < parts.length - 3; i++) {
      groupParts.push(parts[i]);
    }
  } else {
    // Can't find repository marker; try heuristic
    for (let i = parts.length - 4; i >= 0; i--) {
      if (parts[i].includes('.')) {
        groupParts.unshift(parts[i]);
      } else {
        break;
      }
    }
  }

  const groupId = groupParts.join('.');
  if (!groupId || !artifactId || !version) return null;

  // Check if sources.jar exists
  const sourcesJar = jarPath.replace(/\.jar$/, '-sources.jar');
  const hasSource = fs.existsSync(sourcesJar);

  return {
    groupId,
    artifactId,
    version,
    jarPath,
    hasSource,
    scope: 'compile',
  };
}

/** Fallback: parse pom.xml directly when mvn is unavailable */
async function resolveFromPomXml(buildFile: string): Promise<ResolvedDependency[]> {
  try {
    const xml2js = await import('xml2js');
    const pomContent = fs.readFileSync(buildFile, 'utf-8');
    const pom = await xml2js.parseStringPromise(pomContent);

    const deps: ResolvedDependency[] = [];
    const dependencies = pom?.project?.dependencies?.[0]?.dependency || [];

    for (const dep of dependencies) {
      const groupId = dep.groupId?.[0];
      const artifactId = dep.artifactId?.[0];
      const version = dep.version?.[0];
      const scope = dep.scope?.[0] || 'compile';

      if (!groupId || !artifactId || !version) continue;
      if (scope === 'test' || scope === 'provided') continue;

      const jarPath = path.join(
        M2_REPO,
        groupId.replace(/\./g, '/'),
        artifactId,
        version,
        `${artifactId}-${version}.jar`
      );

      if (!fs.existsSync(jarPath)) continue;

      const sourcesJar = path.join(
        M2_REPO,
        groupId.replace(/\./g, '/'),
        artifactId,
        version,
        `${artifactId}-${version}-sources.jar`
      );

      deps.push({
        groupId,
        artifactId,
        version,
        jarPath,
        hasSource: fs.existsSync(sourcesJar),
        scope,
      });
    }

    return deps;
  } catch {
    return [];
  }
}
