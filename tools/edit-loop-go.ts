/**
 * Go translation of the set-C 40-function project (tools/ai-edit-tasks-c.ts) and of the
 * twelve set-C reference edits, for the edit-loop validation benchmark. The translation
 * follows the TypeScript sources function by function: u32 is `uint32` (Go's unsigned
 * arithmetic wraps mod 2^32 natively), u32x4 / u32x32 are fixed arrays, and the A0
 * records (u32, u32) and (u32, bool) are small structs.
 *
 * No model replies exist for Go: the edits are hand translations of the set-B reference
 * edits, which is recorded in the benchmark report.
 */

export const GO_HEADER = 'package project\n\n';

export const GO_TYPES = `type Pair struct {
\tA uint32
\tB uint32
}

type Tagged struct {
\tV uint32
\tF bool
}
`;

export const GO_PROJECT = `func affine(x uint32, scale uint32, offset uint32) uint32 {
\treturn x*scale + offset
}
func is_even(x uint32) bool {
\treturn x&1 == 0
}
func fits(a uint32, b uint32) bool {
\treturn a < b
}
func clamp(x uint32, hi uint32) uint32 {
\tif hi < x {
\t\treturn hi
\t}
\treturn x
}
func addi(acc uint32, i uint32) uint32 {
\treturn acc + i
}
func sumfrom(x uint32) uint32 {
\ts := x
\tfor i := uint32(0); i < 5; i++ {
\t\ts = s + i
\t}
\treturn s
}
func rotl(x uint32, n uint32) uint32 {
\treturn (x << (n & 31)) | (x << ((32 - n) & 31))
}
func rot8(x uint32) uint32 {
\treturn (x << 8) | (x >> 23)
}
func sq(x uint32) uint32 {
\treturn x * x
}
func quad(x uint32) uint32 {
\treturn sq(x)
}
func onlyone(a bool, b bool) bool {
\treturn a || b
}
func absdiff(a uint32, b uint32) uint32 {
\treturn a - b
}
func nb(grid [32]uint32, r uint32, c uint32) uint32 {
\trow := grid[r%32]
\treturn (row >> (c & 31)) & 1
}
func count(grid [32]uint32, r uint32, c uint32) uint32 {
\tru := r - 1
\trd := r + 1
\tcl := c - 1
\tcr := c + 1
\ts := nb(grid, ru, cl)
\ts = s + nb(grid, ru, c)
\ts = s + nb(grid, ru, cr)
\ts = s + nb(grid, r, cl)
\ts = s + nb(grid, r, cr)
\ts = s + nb(grid, rd, cl)
\ts = s + nb(grid, rd, c)
\ts = s + nb(grid, rd, cr)
\treturn s
}
func avgfloor(a uint32, b uint32) uint32 {
\treturn (a + b) >> 1
}
func combine4(a uint32, b uint32, c uint32, d uint32) uint32 {
\treturn a + b + c + d
}
func addel(acc uint32, i uint32, a [4]uint32) uint32 {
\treturn acc + a[i%4]
}
func sumsq(a [4]uint32) uint32 {
\ts := uint32(0)
\tfor i := uint32(0); i < 4; i++ {
\t\ts = s + a[i%4]
\t}
\treturn s
}
func min2(a uint32, b uint32) uint32 {
\tif b < a {
\t\treturn b
\t}
\treturn a
}
func sumto(n uint32) uint32 {
\ts := uint32(0)
\tfor i := uint32(0); i < n; i++ {
\t\ts = s + i
\t}
\treturn s
}
func inrange(x uint32, lo uint32, hi uint32) bool {
\treturn x > lo && x < hi
}
func inc(s uint32, i uint32, limit uint32) uint32 {
\treturn s + 1
}
func below(s uint32, i uint32, limit uint32) bool {
\treturn s < limit
}
func countup(limit uint32, cap uint32) uint32 {
\ts := uint32(0)
\tfor i := uint32(0); i < cap; i++ {
\t\tif !(s < limit) {
\t\t\tbreak
\t\t}
\t\ts = s + 1
\t}
\treturn s
}
func minmax(acc Pair, i uint32, a [4]uint32) Pair {
\tlo := acc.A
\thi := acc.B
\tx := a[i%4]
\tnlo := lo
\tif x < lo {
\t\tnlo = x
\t}
\tnhi := hi
\tif x < hi {
\t\tnhi = x
\t}
\treturn Pair{nlo, nhi}
}
func bounds(a [4]uint32) Pair {
\tlo := uint32(0xffffffff)
\thi := uint32(0)
\tfor i := uint32(0); i < 4; i++ {
\t\tx := a[i%4]
\t\tif x < lo {
\t\t\tlo = x
\t\t}
\t\tif x < hi {
\t\t\thi = x
\t\t}
\t}
\treturn Pair{lo, hi}
}
func pick(r Tagged) uint32 {
\treturn r.V
}
func bitstep(acc uint32, i uint32, x uint32) uint32 {
\treturn acc + ((x >> (i & 31)) & 1)
}
func popcount(x uint32) uint32 {
\tn := uint32(0)
\tfor i := uint32(0); i < 32; i++ {
\t\tn = bitstep(n, i, x)
\t}
\treturn n
}
func mixel(acc uint32, i uint32, a [4]uint32) uint32 {
\treturn acc ^ a[i%4]
}
func checksum(a [4]uint32) uint32 {
\th := uint32(0)
\tfor i := uint32(0); i < 4; i++ {
\t\th = h ^ a[i%4]
\t}
\treturn h
}
func byte1(x uint32) uint32 {
\treturn (x >> 8) & 0xff
}
func dstep(acc uint32, i uint32, a [4]uint32, b [4]uint32) uint32 {
\treturn acc + a[i%4]*b[i%4]
}
func dot(a [4]uint32, b [4]uint32) uint32 {
\ts := uint32(0)
\tfor i := uint32(0); i < 4; i++ {
\t\ts = s + a[i%4]*b[i%4]
\t}
\treturn s
}
func sadd(a uint32, b uint32) uint32 {
\treturn a + b
}
func rowpop(acc uint32, i uint32, grid [32]uint32) uint32 {
\treturn acc + popcount(grid[i%32])
}
func population(grid [32]uint32) uint32 {
\tn := uint32(0)
\tfor i := uint32(0); i < 32; i++ {
\t\tn = rowpop(n, i, grid)
\t}
\treturn n
}
func limit(x uint32, lo uint32, hi uint32) uint32 {
\tb := x
\tif x < lo {
\t\tb = lo
\t}
\tif b > hi {
\t\treturn hi
\t}
\treturn b
}
func pstep(acc uint32, i uint32, x uint32) uint32 {
\treturn acc + ((x >> (i & 31)) & 1)
}
func popcnt(x uint32) uint32 {
\ts := uint32(0)
\tfor i := uint32(0); i < 32; i++ {
\t\ts = s + ((x >> i) & 1)
\t}
\treturn s
}
`;

/** Reference edit per set-C task: the whole replacement (or new) functions, in order. */
export const GO_EDITS: Readonly<Record<string, string>> = {
  'c-fits-inclusive': `func fits(a uint32, b uint32) bool {
\treturn a <= b
}
`,
  'c-sumfrom-eight': `func sumfrom(x uint32) uint32 {
\ts := x
\tfor i := uint32(0); i < 8; i++ {
\t\ts = s + i
\t}
\treturn s
}
`,
  'c-rot8-constant': `func rot8(x uint32) uint32 {
\treturn (x << 8) | (x >> 24)
}
`,
  'c-onlyone-xor': `func onlyone(a bool, b bool) bool {
\treturn a != b
}
`,
  'c-avgfloor-nowrap': `func avgfloor(a uint32, b uint32) uint32 {
\treturn (a & b) + ((a ^ b) >> 1)
}
`,
  'c-sumsq-array': `func sumsq(a [4]uint32) uint32 {
\ts := uint32(0)
\tfor i := uint32(0); i < 4; i++ {
\t\tx := a[i%4]
\t\ts = s + x*x
\t}
\treturn s
}
`,
  'c-inrange-inclusive': `func inrange(x uint32, lo uint32, hi uint32) bool {
\treturn x >= lo && x <= hi
}
`,
  'c-bounds-largest': `func bounds(a [4]uint32) Pair {
\tlo := uint32(0xffffffff)
\thi := uint32(0)
\tfor i := uint32(0); i < 4; i++ {
\t\tx := a[i%4]
\t\tif x < lo {
\t\t\tlo = x
\t\t}
\t\tif x > hi {
\t\t\thi = x
\t\t}
\t}
\treturn Pair{lo, hi}
}
`,
  'c-checksum-poly': `func checksum(a [4]uint32) uint32 {
\th := uint32(7)
\tfor i := uint32(0); i < 4; i++ {
\t\th = h*31 + a[i%4]
\t}
\treturn h
}
`,
  'c-norm2-dot': `func norm2(a [4]uint32) uint32 {
\treturn dot(a, a)
}
`,
  'c-pctof-limit': `func pctof(part uint32, whole uint32) uint32 {
\tn := part * 100
\tq := uint32(0xffffffff)
\tif whole != 0 {
\t\tq = n / whole
\t}
\treturn limit(q, 0, 100)
}
`,
  'c-hamming-popcnt': `func hamming(a uint32, b uint32) uint32 {
\treturn popcnt(a ^ b)
}
`,
};

/** Top-level `func` declarations of a Go source, by name, each ending in a newline. */
function splitGo(source: string): Map<string, string> {
  const out = new Map<string, string>();
  let name: string | undefined;
  let lines: string[] = [];
  const flush = (): void => {
    if (name !== undefined) out.set(name, `${lines.join('\n').trimEnd()}\n`);
  };
  for (const line of source.split('\n')) {
    const m = /^func ([A-Za-z_][A-Za-z0-9_]*)\(/.exec(line);
    if (m !== null) {
      flush();
      name = m[1];
      lines = [];
    }
    if (name !== undefined) lines.push(line);
  }
  flush();
  return out;
}

/** The whole Go file: the project with `edit` functions replacing or appending by name. */
export function goFile(edit?: string): string {
  const base = splitGo(GO_PROJECT);
  const over = edit === undefined ? new Map<string, string>() : splitGo(edit);
  const parts = [...base].map(([n, text]) => over.get(n) ?? text);
  for (const [n, text] of over) if (!base.has(n)) parts.push(text);
  return `${GO_HEADER}${GO_TYPES}\n${parts.join('')}`;
}
