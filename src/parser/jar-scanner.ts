// JAR scanner: indexes JARs into SQLite.
//   - JARs with sources.jar → tree-sitter AST parsing (full methods + Javadoc)
//   - JARs without sources  → bytecode parsing (class names + method signatures, no Javadoc)
// Fernflower decompilation is deferred to query time (source-parser.ts).

import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { statSync, mkdirSync, renameSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import yauzl from 'yauzl';
import { parseJavaSource } from './java-parser.js';
import { parseClassFile } from './classfile-parser.js';
import type { ClassFileInfo } from './classfile-parser.js';
import { getDb } from '../db/index.js';
import type { ParsedClass } from './java-parser.js';

const execAsync = promisify(exec);

// ---- Fernflower (on-demand only, not used during indexing) ----

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

const DECOMPILED_DIR = join(homedir(), '.maven-codegraph', 'decompiled');

function cacheKey(jarPath: string): string {
  const stat = statSync(jarPath);
  return createHash('sha256')
    .update(`${jarPath}:${stat.mtimeMs}:${stat.size}`)
    .digest('hex')
    .substring(0, 16);
}

/** Ensure a decompiled sources jar exists (called on-demand by source-parser.ts). */
export async function ensureSourceJar(mainJarPath: string, hasSource: boolean): Promise<string> {
  if (hasSource) {
    const src = mainJarPath.replace(/\.jar$/, '-sources.jar');
    if (existsSync(src)) return src;
  }

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

// ---- Scan result type ----

export interface ScanResult {
  classesFound: number;
  classesIndexed: number;
  methodsIndexed: number;
  errors: string[];
}

// ---- Source JAR scanning (tree-sitter AST) ----

export function scanSourceJar(artifactId: number, sourceJarPath: string): Promise<ScanResult> {
  return scanJar(artifactId, sourceJarPath, 'source');
}

// ---- Class JAR scanning (bytecode, no sources) ----

export function scanClassJar(artifactId: number, mainJarPath: string): Promise<ScanResult> {
  return scanJar(artifactId, mainJarPath, 'bytecode');
}

// ---- Common scanning engine ----

type ScanMode = 'source' | 'bytecode';

function scanJar(artifactId: number, jarPath: string, mode: ScanMode): Promise<ScanResult> {
  const db = getDb();
  const result: ScanResult = { classesFound: 0, classesIndexed: 0, methodsIndexed: 0, errors: [] };

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

  return new Promise((resolve) => {
    yauzl.open(jarPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err || !zipfile) {
        result.errors.push(`Failed to open: ${jarPath}`);
        resolve(result);
        return;
      }

      zipfile.on('entry', (entry) => {
        const ext = mode === 'source' ? '.java' : '.class';
        if (!entry.fileName.endsWith(ext) || entry.fileName.includes('$')) {
          zipfile.readEntry();
          return;
        }
        if (entry.fileName.includes('package-info') || entry.fileName.includes('module-info')) {
          zipfile.readEntry();
          return;
        }
        // For bytecode mode, skip inner/nested classes indicated by path segments after $
        if (mode === 'bytecode' && entry.fileName.includes('$')) {
          zipfile.readEntry();
          return;
        }

        result.classesFound++;

        zipfile.openReadStream(entry, (err, readStream) => {
          if (err || !readStream) { zipfile.readEntry(); return; }
          const chunks: Buffer[] = [];
          readStream.on('data', (c: Buffer) => chunks.push(c));
          readStream.on('end', () => {
            const buf = Buffer.concat(chunks);
            try {
              if (mode === 'source') {
                const source = buf.toString('utf-8');
                const parsed = parseJavaSource(source);
                indexClasses(parsed, artifactId, result, entry.fileName, insertNode, insertEdge, insertMethod, db);
              } else {
                const info = parseClassFile(buf);
                if (info && info.className) {
                  indexBytecodeClass(info as ClassFileInfo & { className: string }, artifactId, result, entry.fileName, insertNode, insertEdge, insertMethod, db);
                }
              }
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

// ---- Index parsed source classes ----

function indexClasses(
  parsed: ParsedClass[],
  artifactId: number,
  result: ScanResult,
  fileName: string,
  insertNode: any,
  insertEdge: any,
  insertMethod: any,
  db: any,
): void {
  const tx = db.transaction(() => {
    for (const cls of parsed) {
      const nodeR = insertNode.run(
        artifactId, cls.className, cls.simpleName, cls.kind,
        cls.superClass, JSON.stringify(cls.interfaces), '{}', null, fileName,
      );

      if (nodeR.changes > 0) {
        result.classesIndexed++;
        const nodeId = nodeR.lastInsertRowid as number;

        if (cls.superClass && cls.superClass !== 'java.lang.Object') {
          insertEdge.run(nodeId, cls.superClass, 'extends', artifactId);
        }
        for (const iface of cls.interfaces) {
          insertEdge.run(nodeId, iface, 'implements', artifactId);
        }

        for (const m of cls.methods) {
          if (!m.isPublic) continue;
          insertMethod.run(
            nodeId, m.name, m.signature, m.returnType,
            JSON.stringify(m.parameterTypes), JSON.stringify(m.parameterNames),
            JSON.stringify({ isPublic: m.isPublic, isStatic: m.isStatic }),
            m.docstring,
          );
          result.methodsIndexed++;
        }
      }
    }
  });
  (tx as any)();
}

// ---- Index bytecode-parsed classes ----

function indexBytecodeClass(
  info: ClassFileInfo & { className: string },
  artifactId: number,
  result: ScanResult,
  fileName: string,
  insertNode: any,
  insertEdge: any,
  insertMethod: any,
  db: any,
): void {
  const isInterface = (info.accessFlags & 0x0200) !== 0;
  const kind = isInterface ? 'interface' : 'class';
  const simpleName = info.className.split('.').pop() || info.className;

  const tx = db.transaction(() => {
    const nodeR = insertNode.run(
      artifactId, info.className, simpleName, kind,
      info.superClass, JSON.stringify(info.interfaces), '{}', null, fileName,
    );

    if (nodeR.changes > 0) {
      result.classesIndexed++;
      const nodeId = nodeR.lastInsertRowid as number;

      if (info.superClass && info.superClass !== 'java.lang.Object') {
        insertEdge.run(nodeId, info.superClass, 'extends', artifactId);
      }
      for (const iface of info.interfaces) {
        insertEdge.run(nodeId, iface, 'implements', artifactId);
      }

      // Only index public methods (bytecode gives us everything)
      for (const m of info.methods) {
        if (!m.isPublic) continue;
        const sig = bytecodeMethodSignature(m, info.className, isInterface);
        insertMethod.run(
          nodeId, m.name, sig, '',  // return_type extracted in signature
          '[]', '[]',  // parameter names not available from bytecode
          JSON.stringify({ isPublic: true, isStatic: m.isStatic }),
          null,  // no Javadoc from bytecode
        );
        result.methodsIndexed++;
      }
    }
  });
  (tx as any)();
}

function bytecodeMethodSignature(m: { name: string; descriptor: string; isStatic: boolean }, className: string, isInterface: boolean): string {
  const desc = m.descriptor;
  const paren = desc.indexOf(')');
  if (paren < 0) return m.name + desc;

  const paramsDesc = desc.substring(1, paren);
  const retDesc = desc.substring(paren + 1);

  const params = parseDescriptorParams(paramsDesc);
  const ret = descriptorToType(retDesc);
  const visibility = isInterface ? 'public abstract' : 'public';
  const statMod = m.isStatic ? ' static' : '';
  return `${visibility}${statMod} ${ret} ${m.name}(${params.join(', ')})`;
}

function parseDescriptorParams(desc: string): string[] {
  const params: string[] = [];
  let i = 0;
  while (i < desc.length) {
    const ch = desc[i];
    if (ch === '[') {
      let arr = 0;
      while (desc[i] === '[') { arr++; i++; }
      let base: string;
      if (desc[i] === 'L') {
        const end = desc.indexOf(';', i) + 1;
        base = desc.substring(i + 1, end - 1).replace(/\//g, '.');
        i = end;
      } else {
        base = primitiveName(desc[i]);
        i++;
      }
      params.push(base + '[]'.repeat(arr));
    } else if (ch === 'L') {
      const end = desc.indexOf(';', i);
      params.push(desc.substring(i + 1, end).replace(/\//g, '.'));
      i = end + 1;
    } else {
      params.push(primitiveName(ch));
      i++;
    }
  }
  return params;
}

function descriptorToType(desc: string): string {
  if (!desc) return 'void';
  let arr = 0;
  let i = 0;
  while (desc[i] === '[') { arr++; i++; }
  const ch = desc[i];
  if (ch === 'L') {
    const end = desc.indexOf(';', i);
    return desc.substring(i + 1, end).replace(/\//g, '.') + '[]'.repeat(arr);
  }
  return primitiveName(ch) + '[]'.repeat(arr);
}

function primitiveName(ch: string): string {
  switch (ch) {
    case 'B': return 'byte';
    case 'C': return 'char';
    case 'D': return 'double';
    case 'F': return 'float';
    case 'I': return 'int';
    case 'J': return 'long';
    case 'S': return 'short';
    case 'Z': return 'boolean';
    case 'V': return 'void';
    default: return ch;
  }
}
