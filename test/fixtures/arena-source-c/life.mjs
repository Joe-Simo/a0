import { readFile } from 'node:fs/promises';
import { target } from './target.mjs';
import { compileSource } from './transport.mjs';

// Independent cell grid: count eight boolean neighbors directly, then rebuild
// rows. It never calls an A0 interpreter, parser, bitset kernel or backend.
const wrap = (n) => ((n % 32) + 32) % 32;
const board = (cells) => {
  const rows = Array(32).fill(0);
  for (const [x, y] of cells) rows[wrap(y)] += 2 ** wrap(x);
  return rows;
};
function model(rows, command, x, y) {
  const cells = rows.map((row) =>
      Array.from({ length: 32 }, (_, c) => Math.floor(row / 2 ** c) % 2),
    ),
    next = Array.from({ length: 32 }, () => Array(32).fill(0));
  if (command === 0) {
    for (let r = 0; r < 32; r++)
      for (let c = 0; c < 32; c++) {
        let neighbors = 0;
        for (let dr = -1; dr <= 1; dr++)
          for (let dc = -1; dc <= 1; dc++)
            if (dr || dc) neighbors += cells[wrap(r + dr)][wrap(c + dc)];
        next[r][c] = Number(neighbors === 3 || (cells[r][c] && neighbors === 2));
      }
  } else if (command === 1) {
    for (let r = 0; r < 32; r++) next[r] = [...cells[r]];
    next[wrap(y)][wrap(x)] = 1 - next[wrap(y)][wrap(x)];
  }
  return {
    rows: next.map((row) => row.reduce((word, cell, c) => word + cell * 2 ** c, 0)),
    population: next.flat().reduce((n, cell) => n + cell, 0),
  };
}
export async function verifyLife() {
  const glider = [
      [1, 0],
      [2, 1],
      [0, 2],
      [1, 2],
      [2, 2],
    ],
    inputs = [
      [board(glider), 0, 0, 0],
      [board(glider.map(([x, y]) => [x + 30, y + 30])), 0, 0xffffffff, 0xffffffff],
      [
        board([
          [31, 31],
          [0, 31],
          [1, 31],
        ]),
        0,
        7,
        13,
      ],
      [
        board([
          [31, 31],
          [0, 0],
        ]),
        1,
        0xffffffff,
        0xffffffff,
      ],
      [Array(32).fill(0xffffffff), 2, 0xffffffff, 0xffffffff],
    ];
  const result = compileSource(await readFile('examples/life.a0', 'utf8'), { input: 1, output: 1 });
  const invocations = inputs.map(([rows, command, x, y]) => {
    const expected = model(rows, command, x, y);
    return `{
      const uint32_t input[] = {${[...rows, command, x, y].map((v) => `${v}u`).join(',')}};
      const uint32_t output[] = {${expected.rows.map((v) => `${v}u`).join(',')}};
      a0_io io = {0}; expected_token = &io; io.tag = 123456789u;
      memcpy(io.input, input, sizeof input);
      assert(a0_life(&io) == ${expected.population}u);
      assert(io.position == 35 && io.reads == 35 && io.writes == 32 && io.tag == 123456789u);
      assert(memcmp(io.output, output, sizeof output) == 0);
    }`;
  });
  target(
    result,
    `int main(void) {\n${invocations.join('\n')}\n}`,
    `
struct a0_io { uint32_t input[35], position, reads, output[32], writes, tag; };
static struct a0_io *expected_token;
static bool host_read(struct a0_io *t, uint32_t *out) {
  assert(t == expected_token && t->tag == 123456789u && t->position < 35);
  t->reads++; *out = t->input[t->position++]; return true;
}
static void host_write(struct a0_io *t, uint32_t value) {
  assert(t == expected_token && t->tag == 123456789u && t->writes < 32);
  t->output[t->writes++] = value;
}
#define A0_IO_READ(t, out) host_read((t), (out))
#define A0_IO_WRITE(t, value) host_write((t), (value))`,
  );
  return {
    name: 'unchanged Life application/glider/wrapped-neighbors/toggle/clear/host IO',
    cases: inputs.length,
    status: 'passed',
  };
}
