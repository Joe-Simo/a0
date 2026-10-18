/** Rebase parsed source-unit IR. Source grammar, interning and checking remain in A0. */

import {
  type CommentMetadata,
  type ComposedComments,
  composeCommentMetadata,
  composeSourceComments,
  type SourceUnitCommentMetadata,
  type SourceUnitComments,
} from './source-metadata.js';
import type {
  NativeAuthoringAvailability,
  NativeMetadataOwnership,
} from './source-native-authoring.js';
import type { NativeTables } from './source-native-ir.js';

export const PARSED_VECTOR_WIDTHS = [
  [32, 10],
  [35, 2],
  [38, 3],
  [41, 14],
  [44, 14],
  [47, 5],
  [50, 1],
  [53, 3],
  [56, 6],
] as const;
export const SPEC_VECTOR_WIDTHS = [
  [32, 6],
  [35, 1],
  [38, 1],
  [41, 8],
  [44, 7],
  [47, 14],
  [50, 5],
  [62, 5],
] as const;
const NONE = 0xffff_ffff;

export interface NativeUnitSnapshot {
  readonly source: string;
  readonly byteLength: number;
  readonly tables: NativeTables;
  readonly specs: NativeTables;
  readonly symbols: readonly string[];
  readonly typeRows: Uint32Array;
  readonly typeFields: Uint32Array;
  readonly comments: SourceUnitComments;
  readonly metadata?: NativeMetadataOwnership;
}
export interface NativeIrBuilder {
  initialize(source: string, strict: boolean): void;
  symbol(name: string): number;
  type(kind: number, a: number, b: number, fields: Uint32Array): number;
  upload(words: Uint32Array): number;
  get(index: number): number;
  set(index: number, value: number): void;
  authoring?(availability: NativeAuthoringAvailability, descriptor?: Uint32Array): void;
}
export interface NativeUnitOrigin {
  readonly firstLine: number;
  readonly lineCount: number;
  readonly byteStart: number;
  readonly byteLength: number;
}
export interface NativeComposition {
  readonly source: string;
  readonly comments: ComposedComments;
  readonly origins: readonly NativeUnitOrigin[];
}

function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('invalid parsed source-unit IR');
  return value;
}
const word = (row: Uint32Array, index: number): number => need(row[index]);
const table = (tables: NativeTables, slot: number): Uint32Array => need(tables.get(slot));
function add(a: number, b: number): number {
  const value = a + b;
  if (!Number.isSafeInteger(value) || value < 0 || value > NONE)
    throw new Error('source-unit IR exceeds a u32 extent');
  return value;
}

function nativeCommentIds(
  unit: NativeUnitSnapshot,
  base: number,
): SourceUnitCommentMetadata<number> {
  if (unit.metadata === undefined) throw new Error('missing native authoring ownership');
  const lineRows = table(unit.tables, 32),
    comments = table(unit.tables, 38);
  const count = comments.length / 3;
  const range = (first: number, length: number): number[] => {
    if (first > count || length > count - first) throw new Error('invalid native comment range');
    return Array.from({ length }, (_, index) => add(base, first + index));
  };
  const line = (id: number): CommentMetadata<number> | undefined => {
    if (id >= lineRows.length / 10) throw new Error('invalid native comment line');
    const start = id * 10;
    const leading = range(word(lineRows, start + 8), word(lineRows, start + 9));
    const trailing = word(lineRows, start + 7);
    if (trailing !== NONE && trailing >= count) throw new Error('invalid native trailing comment');
    return leading.length || trailing !== NONE
      ? {
          ...(leading.length ? { leading } : {}),
          ...(trailing === NONE ? {} : { trailing: add(base, trailing) }),
        }
      : undefined;
  };
  const functions = table(unit.tables, 41),
    uses = table(unit.tables, 53);
  const tail = range(unit.metadata.tailFirst, unit.metadata.tailCount);
  const profile = unit.metadata.profileLine === NONE ? undefined : line(unit.metadata.profileLine);
  return {
    ...(profile === undefined ? {} : { profileComments: profile }),
    useComments: Array.from({ length: uses.length / 3 }, (_, index) =>
      line(word(uses, index * 3 + 2)),
    ),
    functions: Array.from({ length: functions.length / 14 }, (_, index) => {
      const comments = line(word(functions, index * 14 + 7));
      return {
        ...(comments === undefined ? {} : { comments }),
        ...(index + 1 === functions.length / 14 && tail.length ? { afterComments: tail } : {}),
      };
    }),
    ...(!functions.length && tail.length ? { tailComments: tail } : {}),
  };
}

/** Clone real comment spans into contiguous ownership ranges; original source coordinates survive. */
function publishComposedComments(
  tables: Map<number, Uint32Array>,
  units: readonly SourceUnitCommentMetadata<number>[],
  strict: boolean,
): NativeMetadataOwnership {
  const metadata = composeCommentMetadata(units);
  const original = table(tables, 38),
    comments = Array.from(original);
  const lines = Array.from(table(tables, 32)),
    functions = table(tables, 41);
  if (metadata.functions.length !== functions.length / 14)
    throw new Error('native composed metadata function count mismatch');
  const clone = (ids: readonly number[]): readonly [number, number] => {
    if (!ids.length) return [0, 0];
    const start = ids[0] as number;
    if (
      start < original.length / 3 &&
      ids.length <= original.length / 3 - start &&
      ids.every((id, index) => id === start + index)
    )
      return [start, ids.length];
    const first = comments.length / 3;
    for (const id of ids) {
      if (id >= original.length / 3) throw new Error('invalid composed comment reference');
      add(comments.length, 3);
      comments.push(word(original, id * 3), word(original, id * 3 + 1), word(original, id * 3 + 2));
    }
    return [first, ids.length];
  };
  for (const [index, fn] of metadata.functions.entries()) {
    const line = word(functions, index * 14 + 7);
    if (line >= lines.length / 10) throw new Error('invalid composed function header line');
    const [first, count] = clone(fn.comments?.leading ?? []);
    lines[line * 10 + 7] = fn.comments?.trailing ?? NONE;
    lines[line * 10 + 8] = first;
    lines[line * 10 + 9] = count;
  }
  const [tailFirst, tailCount] = clone(
    metadata.functions.at(-1)?.afterComments ?? metadata.tailComments ?? [],
  );
  const profileLine = strict ? lines.length / 10 : NONE;
  if (strict) {
    add(lines.length, 10);
    lines.push(0, 0, 0, 0, 0, 0, 0, NONE, 0, 0);
  }
  tables.set(32, Uint32Array.from(lines));
  tables.set(38, Uint32Array.from(comments));
  return { profileLine, tailFirst, tailCount };
}
function shift(row: Uint32Array, index: number, base: number): void {
  row[index] = add(word(row, index), base);
}
function mapped(row: Uint32Array, index: number, ids: readonly number[], sentinel = false): void {
  const old = word(row, index);
  row[index] = sentinel && old === NONE ? NONE : need(ids[old]);
}
function lineFeeds(source: string): number {
  let count = 0;
  for (let index = 0; index < source.length; index++) if (source.charCodeAt(index) === 10) count++;
  return count;
}
function allocate(
  units: readonly NativeUnitSnapshot[],
  widths: readonly (readonly [number, number])[],
  specs: boolean,
): Map<number, Uint32Array> {
  return new Map(
    widths.map(([slot, width]) => {
      let length = 0;
      for (const unit of units) {
        const words = table(specs ? unit.specs : unit.tables, slot);
        if (words.length % width) throw new Error('incomplete parsed source-unit row');
        if (specs || slot !== 53) length = add(length, words.length);
      }
      return [slot, new Uint32Array(length)];
    }),
  );
}

/** Inputs must already be resolved and ordered by the shared graph loader. */
export function composeNativeUnits(
  units: readonly NativeUnitSnapshot[],
  builder: NativeIrBuilder,
  strict: boolean,
): NativeComposition {
  const source = units.map((unit) => unit.source).join('\n');
  builder.initialize(source, strict);
  const tables = allocate(units, PARSED_VECTOR_WIDTHS, false);
  const specs = allocate(units, SPEC_VECTOR_WIDTHS, true);
  const positions = new Map<number, number>(),
    specPositions = new Map<number, number>();
  const knownSymbols = new Map<string, number>(),
    knownTypes = new Map<string, number>();
  const origins: NativeUnitOrigin[] = [];
  const commentUnits: SourceUnitCommentMetadata<number>[] = [];
  let byteBase = 0,
    physicalBase = 0;
  const symbol = (name: string): number => {
    const previous = knownSymbols.get(name);
    if (previous !== undefined) return previous;
    const id = builder.symbol(name);
    if (id !== knownSymbols.size) throw new Error('native symbol identity mismatch');
    knownSymbols.set(name, id);
    return id;
  };
  const structuralType = (kind: number, a: number, b: number, fields: Uint32Array): number => {
    const key = kind === 4 ? `r:${fields.join(',')}` : `a:${a},${b}`;
    const previous = knownTypes.get(key);
    if (previous !== undefined) return previous;
    const id = builder.type(kind, a, b, fields);
    knownTypes.set(key, id);
    return id;
  };
  for (const [unitIndex, unit] of units.entries()) {
    const symbolIds = unit.symbols.map(symbol),
      typeIds = [0, 1, 2];
    if (unit.typeRows.length % 5) throw new Error('incomplete parsed source-unit type');
    for (let id = 3; id < unit.typeRows.length / 5; id++) {
      const row = unit.typeRows.subarray(id * 5, id * 5 + 5);
      const kind = word(row, 0),
        a = word(row, 1),
        b = word(row, 2);
      if (kind !== 3 && kind !== 4) throw new Error('invalid parsed source-unit type kind');
      if (kind === 4 && a + b > unit.typeFields.length)
        throw new Error('invalid record field extent');
      const fields =
        kind === 4
          ? Uint32Array.from(unit.typeFields.subarray(a, a + b), (id) => need(typeIds[id]))
          : new Uint32Array();
      typeIds[id] = structuralType(kind, kind === 4 ? 0 : need(typeIds[a]), b, fields);
    }
    const at = (slot: number, width = 1): number => (positions.get(slot) ?? 0) / width;
    const spAt = (slot: number, width = 1): number => (specPositions.get(slot) ?? 0) / width;
    // Physical source lines and filtered line-table row indexes are distinct coordinate spaces.
    const lineBase = at(32, 10),
      wordBase = at(35, 2),
      commentBase = at(38, 3);
    if (builder.authoring) commentUnits.push(nativeCommentIds(unit, commentBase));
    const fnBase = at(41, 14),
      nodeBase = at(44, 14),
      argBase = at(47, 5),
      paramBase = at(50),
      rawBase = at(56, 6);
    const literalBase = spAt(32, 6),
      childBase = spAt(35),
      exampleArgBase = spAt(38);
    const exampleBase = spAt(41, 8),
      contractBase = spAt(44, 7),
      specNodeBase = spAt(47, 14),
      specArgBase = spAt(50, 5);
    const rows = (
      slot: number,
      width: number,
      change: (row: Uint32Array) => void,
      isSpec = false,
    ): void => {
      const input = table(isSpec ? unit.specs : unit.tables, slot);
      const output = table(isSpec ? specs : tables, slot);
      const cursor = isSpec ? specPositions : positions;
      const start = cursor.get(slot) ?? 0;
      const extent = add(start, input.length);
      if (extent > output.length) throw new Error('invalid composed source-unit extent');
      output.set(input, start);
      for (let offset = start; offset < extent; offset += width)
        change(output.subarray(offset, offset + width));
      cursor.set(slot, extent);
    };
    const operand = (row: Uint32Array): void => {
      if (word(row, 0) === 0) mapped(row, 1, symbolIds);
      shift(row, 2, byteBase);
    };
    const node = (row: Uint32Array): void => {
      mapped(row, 0, symbolIds);
      mapped(row, 4, symbolIds, true);
      mapped(row, 5, symbolIds, true);
      shift(row, 6, lineBase);
      shift(row, 7, byteBase);
      shift(row, 9, byteBase);
      if (word(row, 11) & 2) shift(row, 12, byteBase);
    };
    rows(32, 10, (row) => {
      shift(row, 0, physicalBase);
      shift(row, 1, byteBase);
      shift(row, 3, byteBase);
      shift(row, 5, wordBase);
      if (word(row, 7) !== NONE) shift(row, 7, commentBase);
      shift(row, 8, commentBase);
    });
    rows(35, 2, (row) => shift(row, 0, byteBase));
    rows(38, 3, (row) => {
      shift(row, 0, byteBase);
      shift(row, 2, physicalBase);
    });
    rows(41, 14, (row) => {
      mapped(row, 0, symbolIds);
      shift(row, 1, paramBase);
      mapped(row, 3, typeIds);
      shift(row, 4, nodeBase);
      shift(row, 6, argBase);
      for (const index of [7, 8, 9]) shift(row, index, lineBase);
      shift(row, 10, rawBase);
      // Source index retains schema1's combined-source identity; origins are returned separately.
    });
    rows(44, 14, (row) => {
      node(row);
      shift(row, 2, argBase);
    });
    rows(47, 5, operand);
    rows(50, 1, (row) => mapped(row, 0, typeIds));
    // Imports have been resolved by the graph loader, not guessed or reparsed here.
    rows(56, 6, (row) => {
      shift(row, 1, fnBase);
      shift(row, 2, lineBase);
      shift(row, 3, byteBase);
      shift(row, 5, lineBase);
    });
    rows(
      32,
      6,
      (row) => {
        if (word(row, 0) === 3 || word(row, 0) === 4) shift(row, 2, childBase);
        shift(row, 4, byteBase);
      },
      true,
    );
    rows(35, 1, (row) => shift(row, 0, literalBase), true);
    rows(38, 1, (row) => shift(row, 0, literalBase), true);
    rows(
      41,
      8,
      (row) => {
        shift(row, 0, fnBase);
        shift(row, 1, rawBase);
        shift(row, 2, exampleArgBase);
        shift(row, 4, literalBase);
        shift(row, 5, lineBase);
        shift(row, 6, byteBase);
      },
      true,
    );
    rows(
      44,
      7,
      (row) => {
        shift(row, 1, fnBase);
        shift(row, 2, lineBase);
        shift(row, 3, specNodeBase);
        shift(row, 4, rawBase);
        shift(row, 5, byteBase);
      },
      true,
    );
    rows(
      47,
      14,
      (row) => {
        node(row);
        shift(row, 2, specArgBase);
      },
      true,
    );
    rows(50, 5, operand, true);
    rows(
      62,
      5,
      (row) => {
        shift(row, 0, fnBase);
        shift(row, 1, exampleBase);
        if (word(row, 3) !== NONE) shift(row, 3, contractBase);
        if (word(row, 4) !== NONE) shift(row, 4, contractBase);
      },
      true,
    );
    const lineCount = lineFeeds(unit.source) + 1;
    origins.push({
      firstLine: physicalBase + 1,
      lineCount,
      byteStart: byteBase,
      byteLength: unit.byteLength,
    });
    byteBase = add(byteBase, add(unit.byteLength, unitIndex + 1 < units.length ? 1 : 0));
    physicalBase = add(physicalBase, lineCount);
  }
  const metadata = builder.authoring
    ? publishComposedComments(tables, commentUnits, strict)
    : undefined;
  installNativeVectors(builder, tables, specs, metadata);
  return {
    source,
    comments: composeSourceComments(units.map((unit) => unit.comments)),
    origins,
  };
}

/** One ABI publication path for parsed units and grammar-independent structured IR. */
export function installNativeVectors(
  builder: NativeIrBuilder,
  tables: ReadonlyMap<number, Uint32Array | readonly number[]>,
  specs: ReadonlyMap<number, Uint32Array | readonly number[]>,
  metadata?: NativeMetadataOwnership,
): void {
  const upload = (words: Uint32Array | readonly number[]): number =>
    builder.upload(words instanceof Uint32Array ? words : Uint32Array.from(words));
  for (const [slot, words] of tables) {
    builder.set(slot, upload(words));
    builder.set(slot + 1, words.length);
    builder.set(slot + 2, words.length);
  }
  const directory = new Uint32Array(128);
  directory[6] = builder.get(6);
  // Match the A0 spec directory: a spec page has no profile declaration line.
  directory[24] = NONE;
  directory[92] = 1;
  for (const [slot, words] of specs) {
    directory[slot] = upload(words);
    directory[slot + 1] = words.length;
    directory[slot + 2] = words.length;
  }
  for (let index = 0; index < 6; index++) directory[80 + index] = builder.get(62 + index);
  builder.set(59, builder.upload(directory));
  builder.set(60, directory.length);
  builder.set(61, directory.length);
  const raw = tables.get(56);
  if (raw === undefined) throw new Error('missing native specification rows');
  builder.set(30, raw.length ? 1 : 0);
  if (metadata !== undefined) builder.set(24, metadata.profileLine);
  builder.set(25, metadata?.tailFirst ?? 0);
  builder.set(26, metadata?.tailCount ?? 0);
}
