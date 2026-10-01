/**
 * A0M: A0 with macros. compiler/shape.a0 is generated from compiler/shape.a0m with it
 * (`bun tools/a0m.ts compiler/shape.a0m compiler/shape.a0`; `--check` as a third argument
 * compares instead of writing). A0 has no control flow and a table passed to a call is copied by
 * the C emitter, so reads and writes of the paged tables (`u32x128xN`: word i at page i >> 7,
 * word i & 127) are written out inline in every step, four or five lines each. A0M names them:
 * a line `@name args...` expands to A0 lines (macros nest), any other line is A0 unchanged.
 *
 *   @rd V T I          V = word I of the paged table T
 *   @wr R T I X        R = T with word I set to X
 *   @wrs R T I X GO    R = T with word I set to X when GO, else unchanged
 *   @nwd V T G W       word W of row G of the node table (6 words a row)
 *   @fwd V T F W       word W of row F of the function table (7 words a row)
 *   @aw V T S W        word W (0 kind, 1 value) of operand pair S
 *   @ty V T X W        word W of the triple of type X (the types table u32x384xN)
 *   @tyw R T X W VAL   T with word W of the triple of type X set to VAL
 *   @col V T BASE G    word BASE + G of a column table; @colw R T BASE G X writes it
 *   @pg V T I          V = element I of a flat table (`get`)
 *   @bodyd P T B       the descriptor of function B: P_f first node, P_n node count, P_rw packed
 *                      ret, P_pf first tlist word, P_np parameter count, P_rs result type
 *   @nrow P T G        the row of node G: P_op op, P_na operand count, P_af first operand,
 *                      P_ce callee, P_pd predicate
 *   @opr P T S         the operand pair at slot S: P_k kind, P_v value
 *   @opk P T AF K      operand K of the node whose first operand is AF
 *   @retop P T RW      the ret operand of the packed ret RW (kind 5: read from the operands T)
 *   @isop R K V KK VV  R = the operand pair (K, V) is (KK, VV)
 *   @zarr NAME TYPE N  a function NAME returning a zero table of N pages
 *   @inst T NAME K=V.. the template T (text between `#@template T` and `#@end`) with %NAME%
 *                      and %K% replaced; its lines starting with ? are kept when NEST=1, with !
 *                      when NEST=0 (the prefix is dropped)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

type Macro = (args: readonly string[]) => string[];

const rd: Macro = ([v, t, i]) => [
  `${v}_a shr ${i} 7`,
  `${v}_b get ${t} ${v}_a`,
  `${v}_c and ${i} 127`,
  `${v} get ${v}_b ${v}_c`,
];

const wr: Macro = ([r, t, i, x]) => [
  `${r}_a shr ${i} 7`,
  `${r}_b get ${t} ${r}_a`,
  `${r}_c and ${i} 127`,
  `${r}_d set ${r}_b ${r}_c ${x}`,
  `${r} set ${t} ${r}_a ${r}_d`,
];

/** A table word read at the index V = (row * size + word). */
const rowWord =
  (size: number): Macro =>
  ([v, t, g, w]) => [`${v}_m mul ${g} ${size}`, `${v}_i add ${v}_m ${w}`, `@rd ${v} ${t} ${v}_i`];

const MACROS: Readonly<Record<string, Macro>> = {
  rd,
  wr,
  wrs: ([r, t, i, x, go]) => [
    `@rd ${r}_o ${t} ${i}`,
    `${r}_v select ${go} ${x} ${r}_o`,
    `@wr ${r} ${t} ${i} ${r}_v`,
  ],
  nwd: rowWord(6),
  fwd: rowWord(7),
  aw: rowWord(2),
  ty: ([v, t, x, w]) => [
    `${v}_a shr ${x} 7`,
    `${v}_b get ${t} ${v}_a`,
    `${v}_l and ${x} 127`,
    `${v}_m mul ${v}_l 3`,
    `${v}_i add ${v}_m ${w}`,
    `${v} get ${v}_b ${v}_i`,
  ],
  tyw: ([r, t, x, w, val]) => [
    `${r}_a shr ${x} 7`,
    `${r}_b get ${t} ${r}_a`,
    `${r}_l and ${x} 127`,
    `${r}_m mul ${r}_l 3`,
    `${r}_i add ${r}_m ${w}`,
    `${r}_d set ${r}_b ${r}_i ${val}`,
    `${r} set ${t} ${r}_a ${r}_d`,
  ],
  pg: ([v, t, i]) => [`${v} get ${t} ${i}`],
  col: ([v, t, base, g]) => [`${v}_x add ${base} ${g}`, `@rd ${v} ${t} ${v}_x`],
  colw: ([r, t, base, g, x]) => [`${r}_x add ${base} ${g}`, `@wr ${r} ${t} ${r}_x ${x}`],
  bodyd: ([p, t, b]) => [
    `@fwd ${p}_f ${t} ${b} 4`,
    `@fwd ${p}_n ${t} ${b} 5`,
    `@fwd ${p}_rw ${t} ${b} 6`,
    `@fwd ${p}_pf ${t} ${b} 2`,
    `@fwd ${p}_np ${t} ${b} 1`,
    `@fwd ${p}_rs ${t} ${b} 3`,
  ],
  nrow: ([p, t, g]) => [
    `@nwd ${p}_op ${t} ${g} 1`,
    `@nwd ${p}_na ${t} ${g} 2`,
    `@nwd ${p}_af ${t} ${g} 3`,
    `@nwd ${p}_ce ${t} ${g} 4`,
    `@nwd ${p}_pd ${t} ${g} 5`,
  ],
  opr: ([p, t, s]) => [`@aw ${p}_k ${t} ${s} 0`, `@aw ${p}_v ${t} ${s} 1`],
  opk: ([p, t, af, k]) => [`${p}_s add ${af} ${k}`, `@opr ${p} ${t} ${p}_s`],
  retop: ([p, t, rw]) => [
    `${p}_k0 shr ${rw} 28`,
    `${p}_v0 and ${rw} 268435455`,
    `${p}_i5 eq ${p}_k0 5`,
    `${p}_sl select ${p}_i5 ${p}_v0 0`,
    `@opr ${p}_q ${t} ${p}_sl`,
    `${p}_k select ${p}_i5 ${p}_q_k ${p}_k0`,
    `${p}_v select ${p}_i5 ${p}_q_v ${p}_v0`,
  ],
  isop: ([r, k, v, kk, vv]) => [
    `${r}_a eq ${k} ${kk}`,
    `${r}_b eq ${v} ${vv}`,
    `${r} and ${r}_a ${r}_b`,
  ],
  zarr: ([name, type, n]) => [
    `fn ${name} -> ${type}`,
    'z call zpage',
    `t arr ${Array.from({ length: Number(n) }, () => 'z').join(' ')}`,
    'ret t',
    'end',
  ],
};

/** The A0 text of a source with macros and templates expanded. */
export function expandSource(source: string): string {
  const templates = new Map<string, string[]>();

  const instantiate = (args: readonly string[]): string[] => {
    const [templateName, newName, ...pairs] = args;
    const vars = new Map<string, string>([['NAME', newName ?? '']]);
    for (const pair of pairs) {
      const [k, v] = pair.split('=');
      vars.set(k ?? '', v ?? '');
    }
    const lines = templates.get(templateName ?? '');
    if (lines === undefined) throw new Error(`unknown template ${templateName}`);
    const out: string[] = [];
    for (let line of lines) {
      if (line.startsWith('?') || line.startsWith('!')) {
        if (vars.get('NEST') !== (line.startsWith('?') ? '1' : '0')) continue;
        line = line.slice(1);
      }
      for (const [k, v] of vars) line = line.replaceAll(`%${k}%`, v);
      out.push(...expand(line));
    }
    return out;
  };

  const expand = (line: string): string[] => {
    if (!line.startsWith('@')) return [line];
    const [name, ...args] = line.slice(1).trim().split(/\s+/);
    if (name === 'inst') return instantiate(args);
    const macro = MACROS[name ?? ''];
    if (macro === undefined) throw new Error(`unknown macro ${name}`);
    return macro(args).flatMap(expand);
  };

  const out: string[] = [];
  let template: string | undefined;
  for (const line of source.split('\n')) {
    if (line.startsWith('#@template ')) {
      template = line.split(' ')[1] ?? '';
      templates.set(template, []);
    } else if (line.startsWith('#@end')) template = undefined;
    else if (template !== undefined) templates.get(template)?.push(line);
    else out.push(...expand(line));
  }
  return `${out.join('\n')}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [input, output, flag] = process.argv.slice(2);
  if (input === undefined || output === undefined) {
    process.stderr.write('usage: bun tools/a0m.ts SOURCE.a0m OUTPUT.a0 [--check]\n');
    process.exit(2);
  }
  const text = expandSource(readFileSync(input, 'utf8'));
  if (flag === '--check') {
    if (readFileSync(output, 'utf8') !== text) {
      process.stderr.write(`${output} is not the expansion of ${input}\n`);
      process.exit(1);
    }
  } else writeFileSync(output, text, 'utf8');
}
