import { writeFile } from 'node:fs/promises';
import { scalarMain, target } from './target.mjs';
import { compileSource, ROOT } from './transport.mjs';

const report = { status: 'running', rows: [] };
try {
  for (const size of [511, 513]) {
    const source = `fn sum u32 u32 u32x${size} -> u32
x get p2 p1
ret add p0 x
end
fn make u32 u32 -> (u32x${size},u32x${size},u32)
a [A*${size}]
b [B*${size}]
out rec a b 91
ret out
end
fn probe u32 u32 -> u32
r make A B
a at r 0
b at r 1
tag at r 2
x fold sum ${size} 0 a
y fold sum ${size} 0 b
weighted mul y 7
z add x weighted
ret add z tag
end
`;
    const result = compileSource(source);
    target(
      result,
      scalarMain(
        [
          [0, 1],
          [7, 19],
          [0xffffffff, 0x80000000],
        ].map(([a, b]) => ({
          functionName: 'probe',
          args: [a, b],
          expected: Number(BigInt.asUintN(32, BigInt(size) * (BigInt(a) + 7n * BigInt(b)) + 91n)),
        })),
      ),
    );
    report.rows.push({
      name: `mixed record ${size}: value return and all fields`,
      status: 'passed',
    });
  }
  // Every element differs. A loop over the completed array independently checks
  // element identity instead of accepting one accidentally correct endpoint.
  const size = 1025;
  const source = `fn sum u32 u32 u32x${size} -> u32
x get p2 p1
position add p1 1
weighted mul x position
ret add p0 weighted
end
fn make -> u32x${size}
a arr ${Array.from({ length: size }, (_, i) => (i * 17 + 3) >>> 0).join(' ')}
ret a
end
fn probe -> u32
a make
ret fold sum ${size} 0 a
end
`;
  const expected = Number(
    BigInt.asUintN(
      32,
      Array.from({ length: size }, (_, i) => BigInt(i * 17 + 3) * BigInt(i + 1)).reduce(
        (a, b) => a + b,
        0n,
      ),
    ),
  );
  target(compileSource(source), scalarMain([{ functionName: 'probe', args: [], expected }]));
  report.rows.push({ name: 'large array: all distinct element indices', status: 'passed' });
  const snapshots = compileSource(`fn make u32 u32 -> (u32x513,u32x513)
a [A*513]
b [B*513]
ret rec a b
end
fn probe u32 u32 -> u32
r make A B
a at r 0
changed set a 0 99
old at r 0
b at r 1
x get old 0
y get changed 0
z get b 512
weighted mul z 7
base add x y
ret add base weighted
end
`);
  target(
    snapshots,
    scalarMain(
      [
        [7, 19],
        [0xffffffff, 1],
      ].map(([a, b]) => ({
        functionName: 'probe',
        args: [a, b],
        expected: Number(BigInt.asUintN(32, BigInt(a) + 99n + 7n * BigInt(b))),
      })),
    ),
  );
  report.rows.push({
    name: 'large record return: old field borrow survives separate update',
    status: 'passed',
  });
  const io = compileSource(`fn sum u32 u32 u32x1025 -> u32
x get p2 p1
ret add p0 x
end
fn make io u32 -> (u32x1025,u32,io)
a [p1*1025]
t write p0 11
ret rec a 91 t
end
fn effect io u32 -> u32
r make p0 p1
a at r 0
tag at r 1
t at r 2
u write t tag
value fold sum 1025 0 a
out write u value
ret value
end
`);
  target(
    io,
    `int main(void) { struct a0_io t={0}; expected=&t; assert(a0_effect(&t,7u)==7175u); const uint32_t want[]={11u,91u,7175u}; assert(t.writes==3u); for(unsigned i=0;i<3;i++) assert(t.words[i]==want[i]); }`,
    `struct a0_io { uint32_t writes,words[3]; };
static struct a0_io *expected;
static bool input(struct a0_io *t,uint32_t *out) { assert(t==expected); *out=0; return false; }
static void output(struct a0_io *t,uint32_t word) { assert(t==expected && t->writes<3); t->words[t->writes++]=word; }
#define A0_IO_READ(t,out) input((t),(out))
#define A0_IO_WRITE(t,word) output((t),(word))`,
  );
  report.rows.push({
    name: 'large array and mixed record/IO return: affine token and ordered effects',
    status: 'passed',
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = { message: error.message, stack: error.stack };
}
await writeFile(`${ROOT}/results.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.status === 'passed' ? 0 : 1;
