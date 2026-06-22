// Core type definitions for maven-code-graph

/** Maven artifact coordinate */
export interface ArtifactCoordinate {
  groupId: string;
  artifactId: string;
  version: string;
}

/** Full artifact record stored in DB */
export interface Artifact extends ArtifactCoordinate {
  id: number;
  jarPath: string;
  hasSource: boolean;
  contentHash: string;
  indexedAt: number;
}

/** Node kinds for class-level symbols in dependency JARs */
export type NodeKind = 'class' | 'interface' | 'enum' | 'annotation';

/** Edge kinds for relationships between classes */
export type EdgeKind = 'extends' | 'implements';

/** Access flags from .class file */
export interface AccessFlags {
  isPublic: boolean;
  isProtected: boolean;
  isPrivate: boolean;
  isStatic: boolean;
  isAbstract: boolean;
  isFinal: boolean;
  isInterface: boolean;
  isEnum: boolean;
  isAnnotation: boolean;
}

/** A class/interface/enum node parsed from a JAR */
export interface Node {
  id: number;
  artifactId: number;
  name: string;          // fully qualified, e.g. com.example.Foo
  simpleName: string;    // e.g. Foo
  kind: NodeKind;
  superClass: string | null;
  interfaces: string[];  // JSON array in DB
  accessFlags: AccessFlags;
  signature: string | null;  // javap-style class signature
  filePath: string;      // path inside JAR, e.g. com/example/Foo.class
}

/** A relationship edge between two classes */
export interface Edge {
  id: number;
  sourceNodeId: number;
  targetNodeName: string;  // FQN of the superclass/interface
  kind: EdgeKind;
  artifactId: number;
}

/** A method parsed from a class */
export interface Method {
  id: number;
  nodeId: number;
  name: string;
  signature: string;       // full method signature, e.g. "public ResultMeta<List<ReadAlbumSongDto>> getAlbumSongListById(Long, String)"
  returnType: string | null;
  parameterTypes: string[]; // JSON array
  parameterNames: string[]; // JSON array (from javap -verbose or sources)
  accessFlags: AccessFlags;
  docstring: string | null; // Javadoc if available
}

/** Project state stored in .maven-codegraph/state.json */
export interface ProjectState {
  projectRoot: string;
  pomHash: string;
  dependencies: ArtifactCoordinate[];
  lastIndexedAt: number;
}

/** Result of Maven dependency resolution */
export interface ResolvedDependency extends ArtifactCoordinate {
  jarPath: string;
  hasSource: boolean;
  scope: string;  // compile, runtime, test, provided
}

/** Class detail for display output */
export interface ClassDetail {
  node: Node;
  artifact: Artifact;
  methods: Method[];
  edges: Edge[];
  sourceCode?: string;
  usedDecompilation?: boolean;
}

/** Search result */
export interface SearchResult {
  node: Node;
  artifact: Artifact;
  score?: number;
}
