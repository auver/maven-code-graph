-- maven-code-graph: SQLite schema for Maven dependency indexing
-- Architecture: global artifact cache (~/.maven-codegraph/artifacts.db)
--               + per-project state (<project>/.maven-codegraph/state.json)

PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
PRAGMA cache_size = -65536;  -- 64 MB
PRAGMA mmap_size = 268435456; -- 256 MB

-- ============================================================
-- Artifacts: Maven dependency JAR metadata
-- ============================================================
CREATE TABLE IF NOT EXISTS artifacts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id        TEXT NOT NULL,
  artifact_id     TEXT NOT NULL,
  version         TEXT NOT NULL,
  jar_path        TEXT NOT NULL,
  has_source      INTEGER NOT NULL DEFAULT 0,
  content_hash    TEXT NOT NULL DEFAULT '',
  indexed_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  UNIQUE(group_id, artifact_id, version)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_coordinate
  ON artifacts(group_id, artifact_id, version);

-- ============================================================
-- Nodes: classes, interfaces, enums, annotations parsed from JARs
-- ============================================================
CREATE TABLE IF NOT EXISTS nodes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id     INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,          -- fully qualified: com.example.Foo
  simple_name     TEXT NOT NULL,          -- just: Foo
  kind            TEXT NOT NULL CHECK(kind IN ('class', 'interface', 'enum', 'annotation')),
  super_class     TEXT,                   -- FQN of superclass, null for Object/interfaces
  interfaces      TEXT NOT NULL DEFAULT '[]',  -- JSON array of FQN interface names
  access_flags    TEXT NOT NULL DEFAULT '{}',  -- JSON: {isPublic, isStatic, ...}
  signature       TEXT,                   -- javap-style class-level type params
  file_path       TEXT NOT NULL,          -- path inside JAR: com/example/Foo.class
  UNIQUE(artifact_id, name)
);

CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_simple_name ON nodes(simple_name);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_artifact ON nodes(artifact_id);

-- ============================================================
-- Edges: extends / implements relationships
-- ============================================================
CREATE TABLE IF NOT EXISTS edges (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source_node_id  INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_node_name TEXT NOT NULL,         -- FQN of target (may not be in nodes if external)
  kind            TEXT NOT NULL CHECK(kind IN ('extends', 'implements')),
  artifact_id     INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_node_name);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);

-- ============================================================
-- Methods: methods parsed from classes
-- ============================================================
CREATE TABLE IF NOT EXISTS methods (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id         INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  signature       TEXT NOT NULL,          -- full javap-style signature
  return_type     TEXT,                   -- e.g., "java.util.List<String>"
  parameter_types TEXT NOT NULL DEFAULT '[]',  -- JSON array
  parameter_names TEXT NOT NULL DEFAULT '[]',  -- JSON array (empty if from javap without -verbose)
  access_flags    TEXT NOT NULL DEFAULT '{}',
  docstring       TEXT,                   -- Javadoc if available
  UNIQUE(node_id, name, signature)
);

CREATE INDEX IF NOT EXISTS idx_methods_node ON methods(node_id);
CREATE INDEX IF NOT EXISTS idx_methods_name ON methods(name);

-- ============================================================
-- FTS5: Full-text search on node names, signatures, docstrings
-- ============================================================
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  name,
  simple_name,
  signature,
  docstring,
  content='nodes',
  content_rowid='id',
  tokenize='trigram'
);

-- Triggers to keep FTS in sync with nodes table
CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, name, simple_name, signature, docstring)
  VALUES (new.id, new.name, new.simple_name, new.signature, NULL);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, simple_name, signature, docstring)
  VALUES ('delete', old.id, old.name, old.simple_name, old.signature, NULL);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, simple_name, signature, docstring)
  VALUES ('delete', old.id, old.name, old.simple_name, old.signature, NULL);
  INSERT INTO nodes_fts(rowid, name, simple_name, signature, docstring)
  VALUES (new.id, new.name, new.simple_name, new.signature, NULL);
END;

-- ============================================================
-- Schema versioning
-- ============================================================
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  description TEXT
);
