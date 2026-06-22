// Tests for maven-code-graph (tree-sitter based indexing)

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================
// JavaParser tests (tree-sitter)
// ============================================================
import { parseJavaSource } from '../src/parser/java-parser.js';

describe('JavaParser (tree-sitter)', () => {
  it('should parse a simple class', () => {
    const src = `package com.example;
    /**
     * My class doc.
     */
    public class Foo extends Bar implements Runnable {
      public void run() {}
      public String getName(int id) { return null; }
    }`;
    const results = parseJavaSource(src);
    expect(results).toHaveLength(1);
    const cls = results[0];
    expect(cls.className).toBe('com.example.Foo');
    expect(cls.simpleName).toBe('Foo');
    expect(cls.kind).toBe('class');
    expect(cls.superClass).toBe('Bar');
    expect(cls.interfaces).toContain('Runnable');
    expect(cls.docstring).toContain('My class doc');
  });

  it('should parse an interface', () => {
    const src = `package com.example;
    public interface MyService {
      void doSomething(String param);
      int getCount();
    }`;
    const results = parseJavaSource(src);
    expect(results[0].kind).toBe('interface');
    expect(results[0].simpleName).toBe('MyService');
    expect(results[0].methods).toHaveLength(2);
    expect(results[0].methods[0].name).toBe('doSomething');
    expect(results[0].methods[0].parameterNames).toContain('param');
  });

  it('should parse an enum', () => {
    const src = `package com.example;
    public enum Color { RED, GREEN, BLUE; }`;
    const results = parseJavaSource(src);
    expect(results[0].kind).toBe('enum');
    expect(results[0].simpleName).toBe('Color');
  });

  it('should handle no superclass', () => {
    const src = `public class Standalone {}`;
    const results = parseJavaSource(src);
    expect(results[0].superClass).toBeNull();
  });

  it('should handle no package declaration', () => {
    const src = `class DefaultPkg {}`;
    const results = parseJavaSource(src);
    expect(results[0].className).toBe('DefaultPkg');
  });

  it('should parse multiple top-level classes', () => {
    // Java allows multiple top-level types if at most one is public
    const src = `class A {} class B {}`;
    const results = parseJavaSource(src);
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('should extract method parameters with types', () => {
    const src = `package test;
    public class Params {
      public void foo(String name, int age, List<String> items) {}
    }`;
    const results = parseJavaSource(src);
    const m = results[0].methods[0];
    expect(m.parameterNames).toContain('name');
    expect(m.parameterNames).toContain('age');
    expect(m.parameterTypes.length).toBe(3);
  });

  it('should handle generic return types', () => {
    const src = `package test;
    public class Generic {
      public List<String> getNames() { return null; }
      public Map<Long, ReadAlbumSongDto> getMap() { return null; }
    }`;
    const results = parseJavaSource(src);
    expect(results[0].methods[0].returnType).toBeTruthy();
    expect(results[0].methods[1].returnType).toBeTruthy();
  });

  it('should handle RPC interface like AlbumReadRpcService', () => {
    const src = `package com.netease.music.rep2.read.api.core.album;

import com.netease.music.rep2.common.rpc.meta.ResultMeta;

/**
 * 专辑读rpc服务
 */
public interface AlbumReadRpcService {
    /**
     * 通过专辑id获取专辑歌曲列表信息
     */
    ResultMeta<List<ReadAlbumSongDto>> getAlbumSongListById(Long albumId, String credential);
}`;
    const results = parseJavaSource(src);
    expect(results[0].kind).toBe('interface');
    expect(results[0].className).toBe('com.netease.music.rep2.read.api.core.album.AlbumReadRpcService');
    expect(results[0].methods).toHaveLength(1);
    expect(results[0].methods[0].name).toBe('getAlbumSongListById');
    expect(results[0].methods[0].docstring).toContain('专辑歌曲列表信息');
    expect(results[0].methods[0].parameterNames).toContain('albumId');
    expect(results[0].methods[0].parameterNames).toContain('credential');
  });
});

// ============================================================
// Detector tests
// ============================================================
import { detectProject, hashFile } from '../src/project/detector.js';

describe('detectProject', () => {
  const tmpDir = join(tmpdir(), 'mcg-test-' + Date.now());

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'pom.xml'), '<project></project>');
    mkdirSync(join(tmpDir, 'submodule'), { recursive: true });
    writeFileSync(join(tmpDir, 'submodule', 'pom.xml'), '<project></project>');
    mkdirSync(join(tmpDir, 'no-pom'), { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should find pom.xml in current directory', () => {
    const info = detectProject(tmpDir);
    expect(info).not.toBeNull();
    expect(info!.buildFile).toBe(join(tmpDir, 'pom.xml'));
  });

  it('should find pom.xml from subdirectory', () => {
    const info = detectProject(join(tmpDir, 'no-pom'));
    expect(info).not.toBeNull();
    expect(info!.buildFile).toBe(join(tmpDir, 'pom.xml'));
  });

  it('should find submodule pom.xml when closest', () => {
    const info = detectProject(join(tmpDir, 'submodule'));
    expect(info).not.toBeNull();
    expect(info!.buildFile).toBe(join(tmpDir, 'submodule', 'pom.xml'));
  });

  it('hashFile should produce deterministic SHA-256', () => {
    const testFile = join(tmpDir, 'hash-test.txt');
    writeFileSync(testFile, 'hello world');
    expect(hashFile(testFile)).toBe(hashFile(testFile));
  });

  it('hashFile should change when content changes', () => {
    const testFile = join(tmpDir, 'hash-test.txt');
    writeFileSync(testFile, 'hello');
    const h1 = hashFile(testFile);
    writeFileSync(testFile, 'hello!');
    expect(hashFile(testFile)).not.toBe(h1);
  });
});

// ============================================================
// State tests
// ============================================================
import { readState, writeState, isStale, diffDependencies } from '../src/project/state.js';
import type { ProjectState, ArtifactCoordinate } from '../src/types.js';
import type { ProjectInfo } from '../src/project/detector.js';

describe('state management', () => {
  const tmpDir = join(tmpdir(), 'mcg-state-' + Date.now());
  const pomPath = join(tmpDir, 'pom.xml');

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(pomPath, '<project></project>');
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return null when no state exists', () => {
    expect(readState(pomPath)).toBeNull();
  });

  it('should write and read state', () => {
    writeState(pomPath, {
      projectRoot: tmpDir, pomHash: 'abc',
      dependencies: [{ groupId: 'a', artifactId: 'b', version: '1' }],
      lastIndexedAt: Date.now(),
    });
    expect(readState(pomPath)!.pomHash).toBe('abc');
  });

  it('isStale true when no state', () => {
    const p: ProjectInfo = { root: tmpDir, moduleDir: tmpDir, buildSystem: 'maven', buildFile: pomPath };
    expect(isStale(p, null)).toBe(true);
  });

  it('diffDependencies detects changes', () => {
    const old: ArtifactCoordinate[] = [{ groupId: 'a', artifactId: 'b', version: '1' }];
    expect(diffDependencies(old, [{ groupId: 'a', artifactId: 'b', version: '2' }])).toHaveLength(1);
    expect(diffDependencies(old, [{ groupId: 'a', artifactId: 'b', version: '1' }])).toHaveLength(0);
  });

  it('each pom.xml gets independent state', () => {
    const sub = join(tmpDir, 'sub');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'pom.xml'), '<project></project>');
    writeState(pomPath, { projectRoot: tmpDir, pomHash: 'root', dependencies: [], lastIndexedAt: 0 });
    writeState(join(sub, 'pom.xml'), { projectRoot: sub, pomHash: 'sub', dependencies: [], lastIndexedAt: 0 });
    expect(readState(pomPath)!.pomHash).toBe('root');
    expect(readState(join(sub, 'pom.xml'))!.pomHash).toBe('sub');
  });
});

// ============================================================
// DB tests
// ============================================================
import { getDb, closeDb } from '../src/db/index.js';
import { upsertArtifact, isArtifactIndexed, getStats } from '../src/db/queries.js';

describe('database', () => {
  afterAll(() => closeDb());

  it('getStats returns numbers', () => {
    const s = getStats();
    expect(typeof s.totalArtifacts).toBe('number');
    expect(typeof s.totalNodes).toBe('number');
  });

  it('upsertArtifact is idempotent', () => {
    const id1 = upsertArtifact({ groupId: 'test', artifactId: 'x', version: '1' }, '/tmp/x.jar', false, 'h');
    const id2 = upsertArtifact({ groupId: 'test', artifactId: 'x', version: '1' }, '/tmp/x.jar', false, 'h');
    expect(id1).toBe(id2);
  });
});
