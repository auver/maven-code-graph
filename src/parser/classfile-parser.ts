// Minimal JVM .class file parser — extracts class name, superclass, interfaces,
// and method descriptors without full disassembly. Used for lightweight indexing
// of JARs that don't ship with -sources.jar.

export interface ClassFileInfo {
  className: string | null;
  superClass: string | null;
  interfaces: string[];
  accessFlags: number;
  methods: ClassMethod[];
}

export interface ClassMethod {
  name: string;
  descriptor: string;
  signature: string;  // human-readable: "int getValue(String, long)"
  accessFlags: number;
  isPublic: boolean;
  isStatic: boolean;
}

const ACC_PUBLIC = 0x0001;
const ACC_STATIC = 0x0008;
const ACC_INTERFACE = 0x0200;

export function parseClassFile(buf: Buffer): ClassFileInfo | null {
  if (buf.length < 10) return null;
  if (buf[0] !== 0xCA || buf[1] !== 0xFE || buf[2] !== 0xBA || buf[3] !== 0xBE) return null;

  let off = 8; // skip magic + minor/major version
  const cp = parseConstantPool(buf, off);
  off = cp.endOffset;

  const accessFlags = buf.readUInt16BE(off); off += 2;

  const thisIdx = buf.readUInt16BE(off); off += 2;
  const superIdx = buf.readUInt16BE(off); off += 2;
  const ifCount = buf.readUInt16BE(off); off += 2;

  const className = resolveClass(cp.entries, thisIdx);
  const superClass = superIdx === 0 ? null : resolveClass(cp.entries, superIdx);

  const interfaces: string[] = [];
  for (let i = 0; i < ifCount; i++) {
    const name = resolveClass(cp.entries, buf.readUInt16BE(off));
    if (name) interfaces.push(name);
    off += 2;
  }

  // Skip fields
  const fieldCount = buf.readUInt16BE(off); off += 2;
  for (let i = 0; i < fieldCount; i++) {
    off += 6; // access_flags + name_index + descriptor_index
    off = skipAttributes(buf, off);
  }

  // Parse methods
  const methodCount = buf.readUInt16BE(off); off += 2;
  const methods: ClassMethod[] = [];
  for (let i = 0; i < methodCount; i++) {
    const mf = buf.readUInt16BE(off); off += 2;
    const nameIdx = buf.readUInt16BE(off); off += 2;
    const descIdx = buf.readUInt16BE(off); off += 2;

    const name = cp.entries[nameIdx]?.value || '';
    const descriptor = cp.entries[descIdx]?.value || '';
    const sig = descriptorToSignature(name, descriptor);

    methods.push({
      name,
      descriptor,
      signature: sig,
      accessFlags: mf,
      isPublic: (mf & ACC_PUBLIC) !== 0,
      isStatic: (mf & ACC_STATIC) !== 0,
    });

    off = skipAttributes(buf, off);
  }

  return { className, superClass, interfaces, accessFlags, methods };
}

// ---- Constant pool ----

interface CpEntry {
  tag: number;
  value: string;    // resolved string value
  ref1?: number;
  ref2?: number;
}

interface CpResult {
  entries: CpEntry[];
  endOffset: number;
}

function parseConstantPool(buf: Buffer, startOff: number): CpResult {
  const entries: CpEntry[] = [];
  entries[0] = { tag: 0, value: '' }; // index 0 unused

  const count = buf.readUInt16BE(startOff);
  let off = startOff + 2;

  for (let i = 1; i < count; i++) {
    const tag = buf[off++];
    switch (tag) {
      case 1: { // CONSTANT_Utf8
        const len = buf.readUInt16BE(off); off += 2;
        entries[i] = { tag, value: buf.toString('utf-8', off, off + len) };
        off += len;
        break;
      }
      case 7: // CONSTANT_Class → index to Utf8
        entries[i] = { tag, value: '', ref1: buf.readUInt16BE(off) };
        off += 2;
        break;
      case 9:  // CONSTANT_Fieldref
      case 10: // CONSTANT_Methodref
      case 11: // CONSTANT_InterfaceMethodref
        entries[i] = { tag, value: '', ref1: buf.readUInt16BE(off), ref2: buf.readUInt16BE(off + 2) };
        off += 4;
        break;
      case 8:  // CONSTANT_String
      case 16: // CONSTANT_MethodType
      case 19: // CONSTANT_Module
      case 20: // CONSTANT_Package
        entries[i] = { tag, value: '', ref1: buf.readUInt16BE(off) };
        off += 2;
        break;
      case 15: // CONSTANT_MethodHandle
        entries[i] = { tag, value: '', ref1: buf.readUInt8(off), ref2: buf.readUInt16BE(off + 1) };
        off += 3;
        break;
      case 12: // CONSTANT_NameAndType
        entries[i] = { tag, value: '', ref1: buf.readUInt16BE(off), ref2: buf.readUInt16BE(off + 2) };
        off += 4;
        break;
      case 3: case 4: // CONSTANT_Integer, Float
        entries[i] = { tag, value: '' };
        off += 4;
        break;
      case 5: case 6: // CONSTANT_Long, Double (take two entries)
        entries[i] = { tag, value: '' };
        entries[++i] = { tag: 0, value: '' };
        off += 8;
        break;
      case 17: // CONSTANT_Dynamic
      case 18: // CONSTANT_InvokeDynamic
        entries[i] = { tag, value: '', ref1: buf.readUInt16BE(off), ref2: buf.readUInt16BE(off + 2) };
        off += 4;
        break;
      default:
        return { entries, endOffset: off };
    }
  }

  return { entries, endOffset: off };
}

function resolveClass(cp: CpEntry[], idx: number): string | null {
  const entry = cp[idx];
  if (!entry || entry.tag !== 7) return null;
  const utf8 = cp[entry.ref1!];
  return utf8 ? utf8.value.replace(/\//g, '.').replace(/\./g, '.') : null; // already has dots after replace
}

// ---- Attribute skipping ----

function skipAttributes(buf: Buffer, off: number): number {
  const count = buf.readUInt16BE(off); off += 2;
  for (let i = 0; i < count; i++) {
    off += 2; // attribute_name_index
    const len = buf.readUInt32BE(off); off += 4 + len;
  }
  return off;
}

// ---- Descriptor translation ----

function descriptorToSignature(methodName: string, desc: string): string {
  // Method descriptor: (paramTypes)returnType
  const paren = desc.indexOf(')');
  if (paren < 0) return methodName + desc;

  const paramDesc = desc.substring(1, paren);
  const retDesc = desc.substring(paren + 1);

  const params = parseMethodParams(paramDesc);
  const ret = fieldDescriptor(retDesc);

  let visibility = 'package-private';
  // Note: the caller should set visibility based on accessFlags; here we just build the sig
  return `${visibility} ${ret} ${methodName}(${params.join(', ')})`;
}

function parseMethodParams(desc: string): string[] {
  const params: string[] = [];
  let i = 0;
  while (i < desc.length) {
    const ch = desc[i];
    if (ch === '[') {
      const start = i;
      while (desc[i] === '[') i++;
      if (desc[i] === 'L') {
        const end = desc.indexOf(';', i) + 1;
        params.push(fieldDescriptor(desc.substring(start, end)));
        i = end;
      } else {
        params.push(fieldDescriptor(desc.substring(start, i + 1)));
        i++;
      }
    } else if (ch === 'L') {
      const end = desc.indexOf(';', i) + 1;
      params.push(fieldDescriptor(desc.substring(i, end)));
      i = end;
    } else {
      params.push(fieldDescriptor(ch));
      i++;
    }
  }
  return params;
}

function fieldDescriptor(desc: string): string {
  let arr = 0;
  let i = 0;
  while (i < desc.length && desc[i] === '[') { arr++; i++; }

  let base: string;
  const ch = desc[i];
  switch (ch) {
    case 'B': base = 'byte'; break;
    case 'C': base = 'char'; break;
    case 'D': base = 'double'; break;
    case 'F': base = 'float'; break;
    case 'I': base = 'int'; break;
    case 'J': base = 'long'; break;
    case 'S': base = 'short'; break;
    case 'Z': base = 'boolean'; break;
    case 'V': base = 'void'; break;
    case 'L':
      base = desc.substring(i + 1, desc.indexOf(';', i)).replace(/\//g, '.');
      break;
    default: base = desc.substring(i);
  }

  return base + '[]'.repeat(arr);
}
