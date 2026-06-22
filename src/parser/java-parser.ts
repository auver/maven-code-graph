// Java source parser using tree-sitter
// Extracts: class name, superclass, interfaces, methods, Javadoc

import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';

// Singleton parser
let _parser: Parser | null = null;
function getParser(): Parser {
  if (!_parser) {
    _parser = new Parser();
    _parser.setLanguage(Java);
  }
  return _parser;
}

export interface ParsedClass {
  className: string;       // fully qualified
  simpleName: string;
  kind: 'class' | 'interface' | 'enum' | 'annotation';
  superClass: string | null;
  interfaces: string[];
  docstring: string | null;
  methods: ParsedMethod[];
}

export interface ParsedMethod {
  name: string;
  signature: string;       // human-readable: "public ResultMeta<List<ReadAlbumSongDto>> getAlbumSongListById(Long albumId, String credential)"
  returnType: string;
  parameterTypes: string[];
  parameterNames: string[];
  docstring: string | null;
  isPublic: boolean;
  isStatic: boolean;
}

/**
 * Parse a Java source file and extract all class declarations.
 * Returns all classes found (including nested top-level ones).
 */
export function parseJavaSource(source: string): ParsedClass[] {
  const parser = getParser();
  const tree = parser.parse(source);
  const root = tree.rootNode;

  const packageName = extractPackage(root, source);
  const results: ParsedClass[] = [];

  // Find all top-level class/interface/enum declarations
  collectClasses(root, source, packageName, results);
  return results;
}

function extractPackage(node: any, source: string): string {
  for (const child of node.namedChildren) {
    if (child.type === 'package_declaration') {
      const ident = child.namedChildren.find((c: any) => c.type === 'scoped_identifier');
      return ident ? ident.text : '';
    }
  }
  return '';
}

function collectClasses(node: any, source: string, pkg: string, results: ParsedClass[]): void {
  for (const child of node.namedChildren) {
    const type = child.type;
    if (type === 'class_declaration' || type === 'interface_declaration' ||
        type === 'enum_declaration' || type === 'annotation_type_declaration') {

      const info = parseClassDecl(child, source, pkg);
      if (info) results.push(info);
    }
    // Recurse for nested/inner classes at top level of program
    if (type === 'program') {
      collectClasses(child, source, pkg, results);
    }
  }
}

function parseClassDecl(node: any, source: string, pkg: string): ParsedClass | null {
  let simpleName = '';
  const modifiers: string[] = [];
  let superClass: string | null = null;
  const interfaces: string[] = [];
  let docstring: string | null = null;
  let classBody: any = null;

  for (const child of node.namedChildren) {
    switch (child.type) {
      case 'identifier':
        simpleName = child.text;
        break;
      case 'modifiers':
        for (const m of child.namedChildren) {
          modifiers.push(m.text);
        }
        break;
      case 'superclass':
        superClass = child.namedChildren.map((c: any) => c.text).join('.');
        break;
      case 'super_interfaces':
        for (const iface of child.namedChildren) {
          interfaces.push(iface.namedChildren.map((c: any) => c.text).join('.'));
        }
        // Also handle type_identifier directly in super_interfaces
        if (child.namedChildren.length === 0 || child.namedChildren[0].type !== 'type_list') {
          for (const c of child.namedChildren) {
            interfaces.push(c.text);
          }
        }
        break;
      case 'class_body':
      case 'interface_body':
      case 'enum_body':
        classBody = child;
        break;
    }
  }

  if (!simpleName) return null;

  // Extract Javadoc from preceding comment
  docstring = extractDocstring(node, source);

  // Determine kind
  let kind: ParsedClass['kind'] = 'class';
  if (node.type === 'interface_declaration') kind = 'interface';
  else if (node.type === 'enum_declaration') kind = 'enum';
  else if (node.type === 'annotation_type_declaration') kind = 'annotation';

  // Extract methods
  const methods: ParsedMethod[] = [];
  if (classBody) {
    for (const child of classBody.namedChildren) {
      if (child.type === 'method_declaration' || child.type === 'constructor_declaration') {
        const m = parseMethod(child, source);
        if (m) methods.push(m);
      }
    }
  }

  const className = pkg ? `${pkg}.${simpleName}` : simpleName;

  return {
    className,
    simpleName,
    kind,
    superClass,
    interfaces,
    docstring,
    methods,
  };
}

function parseMethod(node: any, source: string): ParsedMethod | null {
  let name = '';
  let returnType = 'void';
  let isPublic = false;
  let isStatic = false;
  const parameterTypes: string[] = [];
  const parameterNames: string[] = [];
  let docstring: string | null = null;

  for (const child of node.namedChildren) {
    switch (child.type) {
      case 'identifier':
        name = child.text;
        break;
      case 'modifiers':
        for (const m of child.namedChildren) {
          if (m.text === 'public') isPublic = true;
          if (m.text === 'static') isStatic = true;
        }
        break;
      case 'formal_parameters':
        extractParams(child, parameterTypes, parameterNames);
        break;
      case 'type_identifier':
      case 'generic_type':
      case 'array_type':
        returnType = child.text;
        break;
    }
  }

  if (!name && node.type === 'constructor_declaration') {
    name = '<init>';
  }
  if (!name) return null;

  docstring = extractDocstring(node, source);

  // Build human-readable signature
  const params = parameterNames.map((p, i) => `${parameterTypes[i] || ''} ${p}`.trim()).join(', ');
  const visibility = isPublic ? 'public' : 'package-private';
  const stat = isStatic ? 'static ' : '';
  const sig = `${visibility} ${stat}${returnType} ${name}(${params})`;

  return {
    name,
    signature: sig,
    returnType,
    parameterTypes,
    parameterNames,
    docstring,
    isPublic,
    isStatic,
  };
}

function extractParams(node: any, types: string[], names: string[]): void {
  // formal_parameters can contain 'identifier', 'formal_parameter', or comma-separated
  for (const child of node.namedChildren) {
    if (child.type === 'formal_parameter') {
      let ptype = '';
      let pname = '';
      for (const c of child.namedChildren) {
        if (c.type === 'type_identifier' || c.type === 'generic_type' ||
            c.type === 'array_type' || c.type === 'scoped_type_identifier' ||
            c.type === 'wildcard') {
          ptype = c.text;
        }
        if (c.type === 'identifier') {
          pname = c.text;
        }
      }
      types.push(ptype);
      names.push(pname);
    }
  }
  // Handle spread parameter (variable arity)
  for (const child of node.namedChildren) {
    if (child.type === 'spread_parameter') {
      for (const c of child.namedChildren) {
        if (c.type === 'identifier') names.push(c.text);
        // The type is wrapped in the spread
      }
      types.push('...');
    }
  }
}

function extractDocstring(node: any, source: string): string | null {
  // Get the node's start position and look backwards for /** */
  const start = node.startIndex;
  const before = source.substring(Math.max(0, start - 200), start);

  const match = before.match(/\/\*\*([\s\S]*?)\*\/\s*$/);
  if (match) {
    return match[1]
      .split('\n')
      .map(l => l.replace(/^\s*\*\s?/, '').trim())
      .filter(l => l.length > 0 && !l.startsWith('@'))
      .join('\n')
      .trim();
  }
  return null;
}
