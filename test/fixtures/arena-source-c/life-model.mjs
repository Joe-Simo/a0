// Independent cell grid: count eight boolean neighbors directly, then rebuild
// rows. It never calls an A0 interpreter, parser, bitset kernel or backend.
const wrap = (n) => ((n % 32) + 32) % 32;
export const board = (cells) => {
  const rows = Array(32).fill(0);
  for (const [x, y] of cells) rows[wrap(y)] += 2 ** wrap(x);
  return rows;
};
export function model(rows, command, x, y) {
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
