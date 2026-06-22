// JAR scanner: scans sources.jar (or Fernflower-decompiled jar) for .java files,
// parses them with tree-sitter, and indexes class/method data into the DB.

import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { statSync, mkdirSync, renameSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import yauzl from 'yauzl';
import { parseJavaSource } from './java-parser.js';
import { getDb } from '../db/index.js';
import type { ParsedClass } from './java-parser.js';

const execAsync = promisify(exec);

// ============================================================
// Fernflower decompiler resolution
// ============================================================

function findFernflowerJar(): string {
  const candidates = [
    join(dirname(new URL(import.meta.url).pathname), '..', '..', 'lib', 'java-decompiler.jar'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error('java-decompiler.jar not found');
}

function findFernflowerJava(): string {
  if (process.env.FERNFLOWER_JAVA && existsSync(process.env.FERNFLOWER_JAVA)) {
    return process.env.FERNFLOWER_JAVA;
  }
  for (const ideaName of ['IntelliJ IDEA', 'IntelliJ IDEA Community Edition']) {
    const jbr = `/Applications/${ideaName}.app/Contents/jbr/Contents/Home/bin/java`;
    if (existsSync(jbr)) return jbr;
  }
  return 'java';
}

// ============================================================
// Decompiled jar cache
// ============================================================

const DECOMPILED_DIR = join(homedir(), '.maven-codegraph', 'decompiled');

function cacheKey(jarPath: string): string {
  const stat = statSync(jarPath);
  return createHash('sha256')
    .update(`${jarPath}:${stat.mtimeMs}:${stat.size}`)
    .digest('hex')
    .substring(0, 16);
}

/** Ensure a decompiled sources jar exists for the given main jar. Returns path to the source jar. */
export async function ensureSourceJar(mainJarPath: string, hasSource: boolean): Promise<string> {
  if (hasSource) {
    const src = mainJarPath.replace(/\.jar$/, '-sources.jar');
    if (existsSync(src)) return src;
  }

  // Fernflower decompile
  const key = cacheKey(mainJarPath);
  const cached = join(DECOMPILED_DIR, `${key}.jar`);
  if (existsSync(cached)) return cached;

  mkdirSync(DECOMPILED_DIR, { recursive: true });
  const fernflower = findFernflowerJar();
  const java = findFernflowerJava();
  const tmpDir = join(DECOMPILED_DIR, '.tmp');
  mkdirSync(tmpDir, { recursive: true });

  try {
    await execAsync(
      `"${java}" -cp "${fernflower}" org.jetbrains.java.decompiler.main.decompiler.ConsoleDecompiler "${mainJarPath}" "${tmpDir}"`,
      { timeout: 120000, maxBuffer: 2 * 1024 * 1024 }
    );
  } catch (e: any) {
    const versionErr = e.message?.includes('UnsupportedClassVersionError') ||
                       e.message?.includes('has been compiled by a more recent version');
    if (versionErr) {
      throw new Error(
        `Fernflower requires JDK 21+. Current Java (${java}) is too old.\n` +
        `Set FERNFLOWER_JAVA to a JDK 21+ path, e.g.: export FERNFLOWER_JAVA=/path/to/jdk21/bin/java`
      );
    }
    throw new Error(`Fernflower failed: ${e.message}`);
  }

  const jarName = mainJarPath.split('/').pop() || 'decompiled.jar';
  const output = join(tmpDir, jarName);

  if (existsSync(output)) {
    renameSync(output, cached);
    return cached;
  }

  throw new Error('Fernflower produced no output for ' + mainJarPath);
}

// ============================================================
// Scanning
// ============================================================

export interface ScanResult {
  classesFound: number;
  classesIndexed: number;
  methodsIndexed: number;
  errors: string[];
}

/** Scan a source jar (original or decompiled) and index all classes */
export async function scanSourceJar(artifactId: number, sourceJarPath: string): Promise<ScanResult> {
  const db = getDb();
  const result: ScanResult = { classesFound: 0, classesIndexed: 0, methodsIndexed: 0, errors: [] };

  return new Promise((resolve) => {
    yauzl.open(sourceJarPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err || !zipfile) {
        result.errors.push(`Failed to open: ${sourceJarPath}`);
        resolve(result);
        return;
      }

      const insertNode = db.prepare(`
        INSERT OR IGNORE INTO nodes (artifact_id, name, simple_name, kind, super_class, interfaces, access_flags, signature, file_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertEdge = db.prepare(`
        INSERT OR IGNORE INTO edges (source_node_id, target_node_name, kind, artifact_id)
        VALUES (?, ?, ?, ?)
      `);
      const insertMethod = db.prepare(`
        INSERT OR IGNORE INTO methods (node_id, name, signature, return_type, parameter_types, parameter_names, access_flags, docstring)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      zipfile.on('entry', (entry) => {
        if (!entry.fileName.endsWith('.java') || entry.fileName.includes('$')) {
          zipfile.readEntry();
          return;
        }
        // Skip inner path segments that suggest inner classes
        if (entry.fileName.includes('package-info') || entry.fileName.includes('module-info')) {
          zipfile.readEntry();
          return;
        }

        result.classesFound++;

        zipfile.openReadStream(entry, (err, readStream) => {
          if (err || !readStream) {
            zipfile.readEntry();
            return;
          }
          const chunks: Buffer[] = [];
          readStream.on('data', (c) => chunks.push(Buffer.from(c)));
          readStream.on('end', () => {
            const source = Buffer.concat(chunks).toString('utf-8');
            try {
              const parsed = parseJavaSource(source);
              const tx = db.transaction(() => {
                for (const cls of parsed) {
                  // Insert node
                  const nodeR = insertNode.run(
                    artifactId,
                    cls.className,
                    cls.simpleName,
                    cls.kind,
                    cls.superClass,
                    JSON.stringify(cls.interfaces),
                    '{}', // access_flags (parsed more precisely by tree-sitter but kept simple for now)
                    null, // signature
                    entry.fileName,
                  );

                  if (nodeR.changes > 0) {
                    result.classesIndexed++;
                    const nodeId = nodeR.lastInsertRowid as number;

                    // Inheritance edges
                    if (cls.superClass && cls.superClass !== 'java.lang.Object') {
                      insertEdge.run(nodeId, cls.superClass, 'extends', artifactId);
                    }
                    for (const iface of cls.interfaces) {
                      insertEdge.run(nodeId, iface, 'implements', artifactId);
                    }

                    // Methods
                    for (const m of cls.methods) {
                      insertMethod.run(
                        nodeId,
                        m.name,
                        m.signature,
                        m.returnType,
                        JSON.stringify(m.parameterTypes),
                        JSON.stringify(m.parameterNames),
                        JSON.stringify({ isPublic: m.isPublic, isStatic: m.isStatic }),
                        m.docstring,
                      );
                      result.methodsIndexed++;
                    }
                  }
                }
              });
              (tx as any)();
            } catch (e: any) {
              result.errors.push(`${entry.fileName}: ${e.message}`);
            }
            zipfile.readEntry();
          });
        });
      });

      zipfile.on('end', () => resolve(result));
      zipfile.on('error', () => resolve(result));
      zipfile.readEntry();
    });
  });
}
