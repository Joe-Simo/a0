/**
 * Sequential SystemVerilog emission (Gate 4).
 *
 * A function needs sequential state when it performs io, iterates (fold/loop), or calls a
 * function that does. Such functions become clocked modules with a start/done handshake:
 *
 *   clk, rst, start -> done, result
 *   io functions also get an input word handshake (in_data/in_valid/in_ready) and an
 *   output word handshake (out_data/out_valid/out_ready).
 *
 * Pure nodes stay combinational wires. Each effectful or iterating node is a *stage* of a
 * linear finite-state machine executed in program order; stage results are registers.
 * Iteration bodies and predicates are instantiated as modules; a sequential body is run
 * through its own start/done handshake once per iteration. Semantics are those of the
 * interpreter: exact u32 arithmetic, trip counts, early exit, and stream order.
 */

import {
  operandTypeOf,
  SV_MAX_UNROLL,
  svExpr,
  svFieldOffset,
  svOperand,
  svType,
} from './backends.js';
import {
  A0Error,
  bitWidth,
  containsIo,
  isPrimitive,
  type Node,
  type Operand,
  type Type,
  type TypedFunc,
} from './core.js';

/** Hardware width: like bitWidth but io tokens occupy no bits. */
export function hwWidth(t: Type): number {
  if (t === 'io') return 0;
  if (isPrimitive(t)) return bitWidth(t);
  if (t.kind === 'arr') return t.length * hwWidth(t.elem);
  return t.fields.reduce((n, f) => n + hwWidth(f), 0);
}

function hwOffset(t: Type, k: number): number {
  if (isPrimitive(t) || t.kind !== 'rec') throw new A0Error('field offset on non-record');
  return t.fields.slice(0, k).reduce((n, f) => n + hwWidth(f), 0);
}

const hwType = (t: Type): string =>
  t === 'bool' ? 'logic' : `logic [${Math.max(hwWidth(t), 1) - 1}:0]`;

/** Does this function (transitively) need a clocked module? */
export function needsSequential(fn: TypedFunc): boolean {
  if (fn.params.some(containsIo) || containsIo(fn.result)) return true;
  for (const n of fn.nodes) {
    if (n.op === 'read' || n.op === 'write' || n.op === 'puts') return true;
    if (n.op === 'fold' || n.op === 'loop') {
      // Literal counts within the unroll limit stay combinational; anything else is clocked.
      const count = n.args[0];
      if (count === undefined || count.kind !== 'u32' || count.value > SV_MAX_UNROLL) return true;
      const body = fn.calls.get(n.callee ?? '');
      const pred = n.op === 'loop' ? fn.calls.get(n.pred ?? '') : undefined;
      if (body !== undefined && needsSequential(body)) return true;
      if (pred !== undefined && needsSequential(pred)) return true;
    }
    if (n.op === 'call') {
      const callee = fn.calls.get(n.callee ?? '');
      if (callee !== undefined && needsSequential(callee)) return true;
    }
  }
  return false;
}

const hasIo = (fn: TypedFunc): boolean => fn.params.some(containsIo);

interface Stage {
  readonly node: Node;
  readonly index: number;
  readonly kind: 'read' | 'write' | 'puts' | 'iterate' | 'call';
  readonly callee: TypedFunc | undefined;
  readonly pred: TypedFunc | undefined;
  readonly calleeSeq: boolean;
}

function isStage(n: Node, fn: TypedFunc): Stage['kind'] | undefined {
  if (n.op === 'read' || n.op === 'write' || n.op === 'puts') return n.op;
  if (n.op === 'fold' || n.op === 'loop') return 'iterate';
  if (n.op === 'call') {
    const callee = fn.calls.get(n.callee ?? '');
    if (callee !== undefined && needsSequential(callee)) return 'call';
  }
  return undefined;
}

/** Combinational expression for a pure node inside a sequential module (io-aware records). */
function hwExpr(n: Node, fn: TypedFunc): string | undefined {
  const t = fn.types.get(n.id) ?? 'u32';
  if (hwWidth(t) === 0) return undefined; // io tokens and io-only records have no wires
  const [a, b] = n.args.map(svOperand);
  switch (n.op) {
    case 'rec': {
      const parts = n.args
        .filter((arg) => hwWidth(operandTypeOf(fn, arg)) > 0)
        .reverse()
        .map(svOperand);
      return `{${parts.join(', ')}}`;
    }
    case 'at': {
      const rt = operandTypeOf(fn, n.args[0] as Operand);
      const k = n.args[1]?.kind === 'u32' ? n.args[1].value : 0;
      if (isPrimitive(rt) || rt.kind !== 'rec') throw new A0Error('at on non-record');
      return `${a}[${hwOffset(rt, k)} +: ${hwWidth(rt.fields[k] as Type)}]`;
    }
    case 'mov':
      return a;
    case 'put': {
      const rt = operandTypeOf(fn, n.args[0] as Operand);
      const k = n.args[1]?.kind === 'u32' ? n.args[1].value : 0;
      if (isPrimitive(rt) || rt.kind !== 'rec') throw new A0Error('put on non-record');
      return `PUT\t${a}\t${hwOffset(rt, k)}\t${hwWidth(rt.fields[k] as Type)}\t${svOperand(n.args[2] as Operand)}`;
    }
    case 'set': {
      const at = operandTypeOf(fn, n.args[0] as Operand);
      if (isPrimitive(at) || at.kind !== 'arr') throw new A0Error('set on non-array');
      const w = bitWidth(at.elem);
      const idx = n.args[1];
      const base =
        idx?.kind === 'u32' ? `${(idx.value % at.length) * w}` : `((${b} % ${at.length}) * ${w})`;
      return `PUT\t${a}\t${base}\t${w}\t${svOperand(n.args[2] as Operand)}`;
    }
    default:
      return svExpr(n, fn);
  }
}

/** Emit one clocked module. */
export function emitSequential(fn: TypedFunc): string {
  const io = hasIo(fn);
  const stages: Stage[] = [];
  for (const n of fn.nodes) {
    const kind = isStage(n, fn);
    if (kind === undefined) continue;
    const callee = fn.calls.get(n.callee ?? '');
    const pred = n.op === 'loop' ? fn.calls.get(n.pred ?? '') : undefined;
    if (pred !== undefined && needsSequential(pred)) {
      throw new A0Error(`${fn.name}.${n.id}: a loop predicate must be combinational in hardware`);
    }
    stages.push({
      node: n,
      index: stages.length,
      kind,
      callee,
      pred,
      calleeSeq: callee !== undefined && needsSequential(callee),
    });
  }
  const K = stages.length;
  const pcWidth = Math.max(1, Math.ceil(Math.log2(K + 1)));
  const pc = (i: number): string => `${pcWidth}'d${i}`;
  const L: string[] = [];
  const ports = [
    '  input logic clk',
    '  input logic rst',
    '  input logic start',
    ...fn.params.flatMap((t, i) => (hwWidth(t) === 0 ? [] : [`  input ${hwType(t)} p${i}`])),
    '  output logic done',
    `  output ${hwType(fn.result)} result`,
    ...(io
      ? [
          '  input logic [31:0] in_data',
          '  input logic in_valid',
          '  output logic in_ready',
          '  output logic [31:0] out_data',
          '  output logic out_valid',
          '  input logic out_ready',
        ]
      : []),
  ];
  L.push(`module a0_${fn.name} (`, ports.join(',\n'), ');');
  L.push(`  logic [${pcWidth - 1}:0] pc;`, '  logic fin;', `  assign done = fin;`);
  // Wires for every node with bits; stage results come from registers.
  for (const n of fn.nodes) {
    const t = fn.types.get(n.id) ?? 'u32';
    if (hwWidth(t) === 0) continue;
    L.push(`  ${hwType(t)} n_${n.id};`);
  }
  const stageOf = new Map(stages.map((s) => [s.node.id, s] as const));
  // Combinational nodes.
  for (const n of fn.nodes) {
    if (stageOf.has(n.id)) continue;
    if (n.op === 'call') {
      if (hwWidth(fn.types.get(n.id) ?? 'u32') === 0) continue;
      const conns = [
        ...n.args.flatMap((arg, i) =>
          hwWidth(operandTypeOf(fn, arg)) === 0 ? [] : [`.p${i}(${svOperand(arg)})`],
        ),
        `.result(n_${n.id})`,
      ];
      L.push(`  a0_${n.callee ?? ''} u_${n.id} (${conns.join(', ')});`);
      continue;
    }
    const e = hwExpr(n, fn);
    if (e === undefined) continue;
    if (e.startsWith('PUT\t')) {
      const [, src, base, w, v] = e.split('\t');
      L.push(`  always_comb begin n_${n.id} = ${src}; n_${n.id}[${base} +: ${w}] = ${v}; end`);
    } else {
      L.push(`  assign n_${n.id} = ${e};`);
    }
  }
  // Stage registers, instances, and per-stage control.
  const seqBlocks: string[] = [];
  const inReady: string[] = [];
  const outValid: string[] = [];
  const outData: string[] = [];
  const startInit: string[] = [];
  const resets: string[] = [];
  const init = (s: Stage): string[] => {
    const n = s.node;
    if (s.kind === 'iterate') {
      const [, initOp] = n.args;
      const lines = [`it_${n.id} <= 32'd0;`, `ph_${n.id} <= 1'b0;`];
      if (hwWidth(fn.types.get(n.id) ?? 'u32') > 0)
        lines.push(`acc_${n.id} <= ${svOperand(initOp as Operand)};`);
      return lines;
    }
    if (s.kind === 'call') return [`ph_${n.id} <= 1'b0;`];
    if (s.kind === 'puts') return [`it_${n.id} <= 32'd0;`];
    return [];
  };
  for (const s of stages) {
    const n = s.node;
    const t = fn.types.get(n.id) ?? 'u32';
    const w = hwWidth(t);
    const next = s.index + 1;
    const advance = [
      `pc <= ${pc(next)};`,
      ...(next === K ? ["fin <= 1'b1;"] : [`en_${(stages[next] as Stage).node.id} <= 1'b0;`]),
    ];
    L.push(`  logic en_${n.id};`);
    resets.push(`en_${n.id} <= 1'b0;`);
    const entry = init(s);
    const guard = (body: string): string =>
      `if (!en_${n.id}) begin en_${n.id} <= 1'b1; ${entry.join(' ')} end else ${body}`;
    if (w > 0) {
      L.push(`  ${hwType(t)} r_${n.id};`, `  assign n_${n.id} = r_${n.id};`);
    }
    if (s.kind === 'read') {
      inReady.push(`(pc == ${pc(s.index)} && en_${n.id})`);
      seqBlocks.push(
        `        ${pc(s.index)}: ${guard(`if (in_valid) begin r_${n.id} <= in_data; ${advance.join(' ')} end`)}`,
      );
    } else if (s.kind === 'puts') {
      // Stream the length word, then each element, one per accepted transfer.
      const arrT = operandTypeOf(fn, n.args[1] as Operand);
      const len = isPrimitive(arrT) || arrT.kind !== 'arr' ? 0 : arrT.length;
      const arr = svOperand(n.args[1] as Operand);
      L.push(`  logic [31:0] it_${n.id};`);
      outValid.push(`(pc == ${pc(s.index)} && en_${n.id})`);
      outData.push(
        `${pc(s.index)}: out_data = (it_${n.id} == 32'd0) ? 32'd${len} : ${arr}[(it_${n.id} - 32'd1) * 32 +: 32];`,
      );
      seqBlocks.push(
        `        ${pc(s.index)}: ${guard(`if (out_ready) begin if (it_${n.id} == 32'd${len}) begin ${advance.join(' ')} end else begin it_${n.id} <= it_${n.id} + 32'd1; end end`)}`,
      );
    } else if (s.kind === 'write') {
      outValid.push(`(pc == ${pc(s.index)} && en_${n.id})`);
      outData.push(`${pc(s.index)}: out_data = ${svOperand(n.args[1] as Operand)};`);
      seqBlocks.push(
        `        ${pc(s.index)}: ${guard(`if (out_ready) begin ${advance.join(' ')} end`)}`,
      );
    } else if (s.kind === 'call') {
      const callee = s.callee as TypedFunc;
      const cio = hasIo(callee);
      L.push(`  logic ph_${n.id};`, `  logic st_${n.id};`, `  logic dn_${n.id};`);
      resets.push(`st_${n.id} <= 1'b0;`, `ph_${n.id} <= 1'b0;`);
      if (w > 0) L.push(`  ${hwType(t)} cr_${n.id};`);
      if (cio) {
        L.push(`  logic ir_${n.id};`, `  logic ov_${n.id};`, `  logic [31:0] od_${n.id};`);
        inReady.push(`(pc == ${pc(s.index)} && en_${n.id} && ir_${n.id})`);
        outValid.push(`(pc == ${pc(s.index)} && en_${n.id} && ov_${n.id})`);
        outData.push(`${pc(s.index)}: out_data = od_${n.id};`);
      }
      const conns = [
        '.clk(clk)',
        '.rst(rst)',
        `.start(st_${n.id})`,
        ...n.args.flatMap((arg, i) =>
          hwWidth(operandTypeOf(fn, arg)) === 0 ? [] : [`.p${i}(${svOperand(arg)})`],
        ),
        `.done(dn_${n.id})`,
        ...(w > 0 ? [`.result(cr_${n.id})`] : []),
        ...(cio
          ? [
              '.in_data(in_data)',
              `.in_valid(in_valid && pc == ${pc(s.index)})`,
              `.in_ready(ir_${n.id})`,
              `.out_data(od_${n.id})`,
              `.out_valid(ov_${n.id})`,
              `.out_ready(out_ready && pc == ${pc(s.index)})`,
            ]
          : []),
      ];
      L.push(`  a0_${callee.name} u_${n.id} (${conns.join(', ')});`);
      const latch = w > 0 ? `r_${n.id} <= cr_${n.id}; ` : '';
      seqBlocks.push(
        `        ${pc(s.index)}: ${guard(`if (!ph_${n.id}) begin st_${n.id} <= 1'b1; ph_${n.id} <= 1'b1; end else begin st_${n.id} <= 1'b0; if (dn_${n.id} && !st_${n.id}) begin ${latch}${advance.join(' ')} end end`)}`,
      );
    } else {
      // iterate: fold or loop
      const callee = s.callee as TypedFunc;
      const [countOp, , ...extra] = n.args;
      const cio = hasIo(callee);
      L.push(`  logic [31:0] it_${n.id};`, `  logic ph_${n.id};`);
      resets.push(`ph_${n.id} <= 1'b0;`);
      if (w > 0) L.push(`  ${hwType(t)} acc_${n.id};`, `  ${hwType(t)} bw_${n.id};`);
      const bodyPorts = (result: string, seq: boolean): string[] => [
        ...(seq ? ['.clk(clk)', '.rst(rst)', `.start(st_${n.id})`] : []),
        ...(w > 0 ? [`.p0(acc_${n.id})`] : []),
        `.p1(it_${n.id})`,
        ...extra.flatMap((arg, k) =>
          hwWidth(operandTypeOf(fn, arg)) === 0 ? [] : [`.p${k + 2}(${svOperand(arg)})`],
        ),
        ...(seq ? [`.done(dn_${n.id})`] : []),
        ...(w > 0 ? [`.result(${result})`] : []),
        ...(seq && cio
          ? [
              '.in_data(in_data)',
              `.in_valid(in_valid && pc == ${pc(s.index)})`,
              `.in_ready(ir_${n.id})`,
              `.out_data(od_${n.id})`,
              `.out_valid(ov_${n.id})`,
              `.out_ready(out_ready && pc == ${pc(s.index)})`,
            ]
          : []),
      ];
      if (s.calleeSeq) {
        L.push(`  logic st_${n.id};`, `  logic dn_${n.id};`);
        resets.push(`st_${n.id} <= 1'b0;`);
        if (cio) {
          L.push(`  logic ir_${n.id};`, `  logic ov_${n.id};`, `  logic [31:0] od_${n.id};`);
          inReady.push(`(pc == ${pc(s.index)} && en_${n.id} && ir_${n.id})`);
          outValid.push(`(pc == ${pc(s.index)} && en_${n.id} && ov_${n.id})`);
          outData.push(`${pc(s.index)}: out_data = od_${n.id};`);
        }
      }
      L.push(`  a0_${callee.name} u_${n.id} (${bodyPorts(`bw_${n.id}`, s.calleeSeq).join(', ')});`);
      let cont = `it_${n.id} < ${svOperand(countOp as Operand)}`;
      if (s.pred !== undefined) {
        L.push(`  logic pr_${n.id};`);
        const predPorts = [
          ...(w > 0 ? [`.p0(acc_${n.id})`] : []),
          `.p1(it_${n.id})`,
          ...extra.flatMap((arg, k) =>
            hwWidth(operandTypeOf(fn, arg)) === 0 ? [] : [`.p${k + 2}(${svOperand(arg)})`],
          ),
          `.result(pr_${n.id})`,
        ];
        L.push(`  a0_${s.pred.name} u_${n.id}_p (${predPorts.join(', ')});`);
        cont = `(${cont}) && pr_${n.id}`;
      }
      const finish = `${w > 0 ? `r_${n.id} <= acc_${n.id}; ` : ''}${advance.join(' ')}`;
      const step = `${w > 0 ? `acc_${n.id} <= bw_${n.id}; ` : ''}it_${n.id} <= it_${n.id} + 32'd1;`;
      if (s.calleeSeq) {
        seqBlocks.push(
          `        ${pc(s.index)}: ${guard(`if (${cont}) begin if (!ph_${n.id}) begin st_${n.id} <= 1'b1; ph_${n.id} <= 1'b1; end else begin st_${n.id} <= 1'b0; if (dn_${n.id} && !st_${n.id}) begin ${step} ph_${n.id} <= 1'b0; end end end else begin ${finish} end`)}`,
        );
      } else {
        seqBlocks.push(
          `        ${pc(s.index)}: ${guard(`if (${cont}) begin ${step} end else begin ${finish} end`)}`,
        );
      }
    }
    if (s.index === 0) startInit.push(`en_${n.id} <= 1'b0;`);
  }
  const rendered = seqBlocks;
  if (io) {
    L.push(`  assign in_ready = ${inReady.length > 0 ? inReady.join(' || ') : "1'b0"};`);
    L.push(`  assign out_valid = ${outValid.length > 0 ? outValid.join(' || ') : "1'b0"};`);
    L.push(
      '  always_comb begin',
      "    out_data = 32'd0;",
      '    case (pc)',
      ...outData.map((d) => `      ${d}`),
      "      default: out_data = 32'd0;",
      '    endcase',
      '  end',
    );
  }
  L.push(
    '  always_ff @(posedge clk) begin',
    `    if (rst) begin pc <= ${pc(K)}; fin <= 1'b0; ${resets.join(' ')} end`,
    `    else if (pc == ${pc(K)}) begin`,
    `      if (start) begin fin <= 1'b0; pc <= ${pc(0)}; ${startInit.join(' ')}${K === 0 ? ` pc <= ${pc(K)}; fin <= 1'b1;` : ''} end`,
    '    end else begin',
    '      case (pc)',
    ...rendered,
    '        default: ;',
    '      endcase',
    '    end',
    '  end',
  );
  const retW = hwWidth(fn.result);
  L.push(`  assign result = ${retW > 0 ? svOperand(fn.ret) : "1'b0"};`);
  L.push('endmodule');
  return L.join('\n');
}
