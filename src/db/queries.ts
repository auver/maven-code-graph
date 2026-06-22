// Database queries

import { getDb } from './index.js';
import type { Artifact, Node, Edge, Method, SearchResult, ArtifactCoordinate } from '../types.js';

// ============================================================
// Artifact
// ============================================================

export function findArtifact(coord: ArtifactCoordinate): Artifact | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT id, group_id as groupId, artifact_id as artifactId, version,
           jar_path as jarPath, has_source as hasSource
    FROM artifacts WHERE group_id=? AND artifact_id=? AND version=?
  `).get(coord.groupId, coord.artifactId, coord.version) as any;
  return row ? { ...row, hasSource: !!row.hasSource, contentHash: '', indexedAt: 0 } : null;
}

export function isArtifactIndexed(artifactId: number): boolean {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as c FROM nodes WHERE artifact_id=?').get(artifactId) as any;
  return row.c > 0;
}

export function upsertArtifact(coord: ArtifactCoordinate, jarPath: string, hasSource: boolean, contentHash: string): number {
  const db = getDb();
  const r = db.prepare(`
    INSERT OR IGNORE INTO artifacts (group_id, artifact_id, version, jar_path, has_source, content_hash, indexed_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(coord.groupId, coord.artifactId, coord.version, jarPath, hasSource ? 1 : 0, contentHash, Date.now());
  if (r.changes > 0) return r.lastInsertRowid as number;
  const e = findArtifact(coord);
  return e ? e.id : 0;
}

// ============================================================
// Search
// ============================================================

export function searchNodes(query: string, deps?: ArtifactCoordinate[], limit = 50): SearchResult[] {
  const db = getDb();
  let sql: string;
  let params: any[];

  if (deps?.length) {
    const placeholders = deps.map(() => '(?,?,?)').join(',');
    params = deps.flatMap(d => [d.groupId, d.artifactId, d.version]);
    sql = `
      SELECT n.id, n.artifact_id as artId, n.name, n.simple_name as simpleName, n.kind,
             n.super_class as superClass, n.interfaces, n.access_flags as accessFlags,
             n.signature, n.file_path as filePath,
             a.group_id as groupId, a.artifact_id as artifactId, a.version,
             a.jar_path as jarPath, a.has_source as hasSource
      FROM nodes_fts JOIN nodes n ON nodes_fts.rowid=n.rowid JOIN artifacts a ON n.artifact_id=a.id
      WHERE nodes_fts MATCH ? AND (a.group_id,a.artifact_id,a.version) IN (${placeholders})
      ORDER BY rank LIMIT ?
    `;
    params.unshift(query);
    params.push(limit);
  } else {
    sql = `
      SELECT n.id, n.artifact_id as artId, n.name, n.simple_name as simpleName, n.kind,
             n.super_class as superClass, n.interfaces, n.access_flags as accessFlags,
             n.signature, n.file_path as filePath,
             a.group_id as groupId, a.artifact_id as artifactId, a.version,
             a.jar_path as jarPath, a.has_source as hasSource
      FROM nodes_fts JOIN nodes n ON nodes_fts.rowid=n.rowid JOIN artifacts a ON n.artifact_id=a.id
      WHERE nodes_fts MATCH ? ORDER BY rank LIMIT ?
    `;
    params = [query, limit];
  }

  return (db.prepare(sql).all(...params) as any[]).map(row => ({
    node: {
      id: row.id, artifactId: row.artId, name: row.name, simpleName: row.simpleName,
      kind: row.kind, superClass: row.superClass,
      interfaces: JSON.parse(row.interfaces || '[]'),
      accessFlags: JSON.parse(row.accessFlags || '{}'),
      signature: row.signature, filePath: row.filePath,
    },
    artifact: {
      id: row.artId, groupId: row.groupId, artifactId: row.artifactId, version: row.version,
      jarPath: row.jarPath, hasSource: !!row.hasSource, contentHash: '', indexedAt: 0,
    },
  }));
}

/** Get node by exact FQN, optionally scoped to project deps */
export function getNodeByFQN(name: string, deps?: ArtifactCoordinate[]): (Node & { artifact: Artifact }) | null {
  const db = getDb();
  let sql: string; let params: any[];

  if (deps?.length) {
    const ph = deps.map(() => '(?,?,?)').join(',');
    params = deps.flatMap(d => [d.groupId, d.artifactId, d.version]);
    sql = `SELECT n.*, a.group_id as g, a.artifact_id as ai, a.version as v, a.jar_path as jp, a.has_source as hs
           FROM nodes n JOIN artifacts a ON n.artifact_id=a.id
           WHERE n.name=? AND (a.group_id,a.artifact_id,a.version) IN (${ph}) LIMIT 1`;
    params.unshift(name);
  } else {
    sql = `SELECT n.*, a.group_id as g, a.artifact_id as ai, a.version as v, a.jar_path as jp, a.has_source as hs
           FROM nodes n JOIN artifacts a ON n.artifact_id=a.id WHERE n.name=? LIMIT 1`;
    params = [name];
  }

  const row = db.prepare(sql).get(...params) as any;
  if (!row) return null;
  return {
    id: row.id, artifactId: row.artifact_id, name: row.name, simpleName: row.simple_name,
    kind: row.kind, superClass: row.super_class,
    interfaces: JSON.parse(row.interfaces || '[]'),
    accessFlags: JSON.parse(row.access_flags || '{}'),
    signature: row.signature, filePath: row.file_path,
    artifact: {
      id: row.artifact_id, groupId: row.g, artifactId: row.ai, version: row.v,
      jarPath: row.jp, hasSource: !!row.hs, contentHash: '', indexedAt: 0,
    },
  };
}

// ============================================================
// Edges
// ============================================================

export function getEdges(nodeId: number): Edge[] {
  const db = getDb();
  return db.prepare(`
    SELECT id, source_node_id as sourceNodeId, target_node_name as targetNodeName, kind, artifact_id as artifactId
    FROM edges WHERE source_node_id=?
  `).all(nodeId) as Edge[];
}

export function findImplementations(className: string, deps?: ArtifactCoordinate[]): Node[] {
  const db = getDb();
  if (deps?.length) {
    const ph = deps.map(() => '(?,?,?)').join(',');
    const params = deps.flatMap(d => [d.groupId, d.artifactId, d.version]);
    return db.prepare(`
      WITH RECURSIVE h AS (
        SELECT e.source_node_id FROM edges e WHERE e.target_node_name=? AND e.kind='implements'
        UNION SELECT e.source_node_id FROM edges e JOIN h ON e.target_node_name=(SELECT n.name FROM nodes n WHERE n.id=h.source_node_id)
        WHERE e.kind IN ('extends','implements')
      )
      SELECT DISTINCT n.* FROM nodes n JOIN h ON n.id=h.source_node_id
      JOIN artifacts a ON n.artifact_id=a.id
      WHERE (a.group_id,a.artifact_id,a.version) IN (${ph}) LIMIT 100
    `).all(className, ...params) as Node[];
  }
  return db.prepare(`
    WITH RECURSIVE h AS (
      SELECT e.source_node_id FROM edges e WHERE e.target_node_name=? AND e.kind='implements'
      UNION SELECT e.source_node_id FROM edges e JOIN h ON e.target_node_name=(SELECT n.name FROM nodes n WHERE n.id=h.source_node_id)
      WHERE e.kind IN ('extends','implements')
    )
    SELECT DISTINCT n.* FROM nodes n JOIN h ON n.id=h.source_node_id LIMIT 100
  `).all(className) as Node[];
}

// ============================================================
// Methods
// ============================================================

export function getMethods(nodeId: number): Method[] {
  const db = getDb();
  return (db.prepare(`
    SELECT id, node_id as nodeId, name, signature, return_type as returnType,
           parameter_types as parameterTypes, parameter_names as parameterNames,
           access_flags as accessFlags, docstring
    FROM methods WHERE node_id=?
  `).all(nodeId) as any[]).map(r => ({
    ...r,
    parameterTypes: JSON.parse(r.parameterTypes || '[]'),
    parameterNames: JSON.parse(r.parameterNames || '[]'),
    accessFlags: JSON.parse(r.accessFlags || '{}'),
  }));
}

// ============================================================
// Stats
// ============================================================

export function getStats() {
  const db = getDb();
  return {
    totalArtifacts: (db.prepare('SELECT COUNT(*) as c FROM artifacts').get() as any).c,
    totalNodes: (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as any).c,
    totalEdges: (db.prepare('SELECT COUNT(*) as c FROM edges').get() as any).c,
    totalMethods: (db.prepare('SELECT COUNT(*) as c FROM methods').get() as any).c,
  };
}
