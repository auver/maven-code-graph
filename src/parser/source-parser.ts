// On-demand class source extraction from JARs.
// Called when user runs: maven-code-graph class <name> [--type source|docs|signatures]
// Uses tree-sitter (same parser as indexing) for AST-level method extraction.

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import yauzl from 'yauzl';
import { ensureSourceJar } from './jar-scanner.js';
import { parseJavaSource } from './java-parser.js';

const execAsync = promisify(exec);

export type SourceType = 'signatures' | 'docs' | 'source';

export interface ClassSource {
  className: string;
  source?: string;
  signatures?: string[];
  doc?: string;
  lang?: string;
  usedDecompilation?: boolean;
}

export async function getClassSource(
  jarPath: string,
  hasSource: boolean,
  className: string,
  type: SourceType,
): Promise<ClassSource | null> {
  // Fast path: javap for signatures only
  if (type === 'signatures') {
    return javapExtract(jarPath, className);
  }

  // Full extract: open source jar, parse with tree-sitter
  try {
    const srcJar = await ensureSourceJar(jarPath, hasSource);
    const fromDecompiler = !hasSource || !existsSync(jarPath.replace(/\.jar$/, '-sources.jar'));
    const result = await readSourceEntry(srcJar, className, type);
    if (result) return { ...result, usedDecompilation: fromDecompiler };
  } catch {
    // null fallthrough
  }

  return null;
}

// ---- JAR entry reader ----

async function readSourceEntry(
  sourceJarPath: string,
  fqClassName: string,
  type: SourceType,
): Promise<ClassSource | null> {
  const relativePath = fqClassName.replace(/\./g, '/');
  const wanted = new Set([relativePath + '.java', relativePath + '.kt']);

  return new Promise((resolve) => {
    yauzl.open(sourceJarPath, { lazyEntries: true, autoClose: true }, (openErr, zip) => {
      if (openErr || !zip) return resolve(null);

      let done = false;

      zip.on('entry', (entry) => {
        if (done) return;
        if (!wanted.has(entry.fileName)) {
          zip.readEntry();
          return;
        }

        done = true;
        const isKotlin = entry.fileName.endsWith('.kt');
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return resolve(null);

          const bufs: Buffer[] = [];
          stream.on('data', (b: Buffer) => bufs.push(b));
          stream.on('end', () => {
            const text = Buffer.concat(bufs).toString('utf-8');
            resolve(analyzeSource(fqClassName, text, type, isKotlin ? 'kotlin' : 'java'));
          });
        });
      });

      zip.on('end', () => { if (!done) resolve(null); });
      zip.readEntry();
    });
  });
}

// ---- Tree-sitter based analysis ----

function analyzeSource(
  fqClassName: string,
  sourceCode: string,
  type: SourceType,
  lang: string,
): ClassSource {
  if (type === 'source') {
    return { className: fqClassName, source: sourceCode, lang };
  }

  const parsed = parseJavaSource(sourceCode);

  // Find the class matching the requested fully-qualified name
  const match = parsed.find(
    (c) => c.className === fqClassName || c.className.endsWith('.' + fqClassName),
  );

  if (!match) {
    return { className: fqClassName, signatures: [], lang };
  }

  const methodSigs = match.methods.map((m) => m.signature);

  return {
    className: match.className,
    signatures: methodSigs,
    doc: type === 'docs' ? (match.docstring ?? undefined) : undefined,
    lang,
  };
}

// ---- javap fallback ----

async function javapExtract(jarPath: string, className: string): Promise<ClassSource> {
  const cmd = `javap -cp "${jarPath}" "${className}"`;

  try {
    const { stdout } = await execAsync(cmd, { timeout: 10000 });

    const kept: string[] = [];
    for (const raw of stdout.split('\n')) {
      const line = raw.trim();
      if (line === '' || line === '}') continue;
      if (line.startsWith('Compiled from')) continue;
      if (line === 'static {};') continue;
      kept.push(line);
    }

    return { className, signatures: kept, lang: 'java' };
  } catch {
    return { className, signatures: [], lang: 'java' };
  }
}
