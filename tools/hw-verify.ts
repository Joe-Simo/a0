/**
 * Hardware validation of the emitted SystemVerilog:
 *  1. Simulation with Icarus Verilog (iverilog -g2012 + vvp) against the same
 *     BigInt-oracle cases used for software targets.
 *  2. Generic logic synthesis with Yosys (`synth`) reporting cell counts.
 *
 * Stages that ran are stated exactly. No FPGA place-and-route, ASIC timing, area
 * in a real library, or power is measured here.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { compile } from '../src/backends.js';
import type { TypedProgram, Value } from '../src/core.js';
import { needsSequential } from '../src/hw.js';
import { optimize } from '../src/optimize.js';
import { findIverilog, findVvp, findYosys, runTool, withTempDir } from '../src/toolchain.js';
import {
  type Case,
  CORPUS_SEED,
  generateCases,
  generateCorpus,
  hasIoParam,
  isDriverCallable,
} from './corpus.js';
import { writeReport } from './scrub-results.js';

const hex = (v: Value): string => (typeof v === 'boolean' ? (v ? '1' : '0') : v.toString(16));

export function testbench(program: TypedProgram): string {
  const insts = program.functions.map((fn, i) => {
    if (!isDriverCallable(fn))
      return `  // ${fn.name}: aggregate signature, exercised through instantiating modules`;
    const seq = needsSequential(fn);
    const io = hasIoParam(fn);
    const scalars = io ? fn.params.slice(0, -1) : fn.params;
    const decls = scalars.map((t, p) => `  logic ${t === 'u32' ? '[31:0] ' : ''}in_${i}_${p};`);
    const out = `  logic ${fn.result === 'u32' ? '[31:0] ' : ''}out_${i};`;
    const ports = [...scalars.map((_, p) => `.p${p}(in_${i}_${p})`), `.result(out_${i})`];
    if (!seq) return [...decls, out, `  a0_${fn.name} u_${i} (${ports.join(', ')});`].join('\n');
    const extra = [`  logic start_${i};`, `  logic done_${i};`];
    const seqPorts = ['.clk(clk)', '.rst(rst)', `.start(start_${i})`, ...ports, `.done(done_${i})`];
    if (io) {
      extra.push(
        `  logic in_ready_${i};`,
        `  logic out_valid_${i};`,
        `  logic [31:0] out_data_${i};`,
      );
      seqPorts.push(
        '.in_data(tb_in_data)',
        '.in_valid(tb_in_valid)',
        `.in_ready(in_ready_${i})`,
        `.out_data(out_data_${i})`,
        `.out_valid(out_valid_${i})`,
        '.out_ready(tb_out_ready)',
      );
    }
    return [...decls, out, ...extra, `  a0_${fn.name} u_${i} (${seqPorts.join(', ')});`].join('\n');
  });
  // Selected-signal mux so one sampling block serves every sequential module.
  const sel = program.functions.map((fn, i) => {
    if (!isDriverCallable(fn) || !needsSequential(fn)) return undefined;
    const io = hasIoParam(fn);
    return `        ${i}: begin sel_done = done_${i}; sel_in_ready = ${io ? `in_ready_${i}` : "1'b0"}; sel_out_valid = ${io ? `out_valid_${i}` : "1'b0"}; sel_out_data = ${io ? `out_data_${i}` : "32'd0"}; end`;
  });
  const drive = program.functions.map((fn, i) => {
    if (!isDriverCallable(fn)) return `        ${i}: begin $display("skip"); end`;
    const io = hasIoParam(fn);
    const scalars = io ? fn.params.slice(0, -1) : fn.params;
    const sets = scalars.map((_, p) => `in_${i}_${p} = args[${p}];`).join(' ');
    if (!needsSequential(fn)) return `        ${i}: begin ${sets} #1; got = out_${i}; end`;
    return `        ${i}: begin ${sets} @(posedge clk); #1 start_${i} = 1'b1; @(posedge clk); #1 start_${i} = 1'b0; cycles = 0; while (!done_${i} && cycles < 200000) begin @(posedge clk); #1 cycles = cycles + 1; end if (!done_${i}) timeouts = timeouts + 1; cyc_total[${i}] = cyc_total[${i}] + cycles; cyc_cases[${i}] = cyc_cases[${i}] + 1; got = out_${i}; end`;
  });
  const n = program.functions.length;
  const cycReport = program.functions.map((fn, i) =>
    isDriverCallable(fn) && needsSequential(fn)
      ? `    $display("A0CYC fn=%0d cases=%0d cycles=%0d", ${i}, cyc_cases[${i}], cyc_total[${i}]);`
      : undefined,
  );
  return `\`timescale 1ns/1ps
module tb;
  logic clk = 1'b0;
  logic rst = 1'b1;
  always #5 clk = ~clk;
  logic [31:0] tb_in_data;
  logic tb_in_valid = 1'b1;
  logic tb_out_ready = 1'b1;
  logic sel_done, sel_in_ready, sel_out_valid;
  logic [31:0] sel_out_data;
  integer idx = -1;
${insts.join('\n')}
  always_comb begin
    sel_done = 1'b0; sel_in_ready = 1'b0; sel_out_valid = 1'b0; sel_out_data = 32'd0;
    case (idx)
${sel.filter((s) => s !== undefined).join('\n')}
      default: ;
    endcase
  end
  integer cyc_total [0:${n - 1}];
  integer cyc_cases [0:${n - 1}];
  logic [31:0] args [0:63];
  logic [31:0] inwords [0:63];
  logic [31:0] outwords [0:255];
  logic [31:0] expwords [0:255];
  logic [31:0] got;
  logic [31:0] expected;
  integer fd, nargs, nin, nout, expnout, k, total, failures, rc, cycles, timeouts, rpos, running, more;
  // Stream environment: exhausted input reads as 0; every transfer is sampled at the clock edge.
  assign tb_in_data = (rpos < nin) ? inwords[rpos] : 32'd0;
  always @(posedge clk) begin
    if (running) begin
      if (tb_in_valid && sel_in_ready) rpos <= rpos + 1;
      if (sel_out_valid && tb_out_ready) begin outwords[nout] <= sel_out_data; nout <= nout + 1; end
    end
  end
  initial begin
    total = 0; failures = 0; timeouts = 0; running = 0; rpos = 0; nout = 0;
    for (k = 0; k < ${n}; k = k + 1) begin cyc_total[k] = 0; cyc_cases[k] = 0; end
    repeat (2) @(posedge clk);
    #1 rst = 1'b0;
    fd = $fopen("cases.txt", "r");
    if (fd == 0) begin $display("cannot open cases.txt"); $finish; end
    // No break statement: Icarus Verilog 12 (Ubuntu's package) does not support it in a testbench.
    more = 1;
    while (more && !$feof(fd)) begin
      rc = $fscanf(fd, "%d %d", idx, nargs);
      if (rc != 2) more = 0;
      else begin
      for (k = 0; k < nargs; k = k + 1) rc = $fscanf(fd, "%h", args[k]);
      rc = $fscanf(fd, "%h", expected);
      rc = $fscanf(fd, "%d", nin);
      for (k = 0; k < nin; k = k + 1) rc = $fscanf(fd, "%h", inwords[k]);
      rc = $fscanf(fd, "%d", expnout);
      for (k = 0; k < expnout; k = k + 1) rc = $fscanf(fd, "%h", expwords[k]);
      got = 32'hxxxxxxxx; rpos = 0; nout = 0; running = 1;
      case (idx)
${drive.join('\n')}
        default: begin $display("bad index %0d", idx); $finish; end
      endcase
      running = 0;
      total = total + 1;
      if (got !== expected || nout !== expnout) begin
        failures = failures + 1;
        if (failures <= 20) $display("FAIL fn=%0d args=%h,%h,%h,%h expected=%h got=%h outs=%0d/%0d", idx, args[0], args[1], args[2], args[3], expected, got, nout, expnout);
      end else begin
        for (k = 0; k < nout; k = k + 1) if (outwords[k] !== expwords[k]) begin
          failures = failures + 1;
          if (failures <= 20) $display("FAIL fn=%0d out[%0d]=%h expected=%h", idx, k, outwords[k], expwords[k]);
        end
      end
      end
    end
${cycReport.filter((s) => s !== undefined).join('\n')}
    $display("A0SIM total=%0d failures=%0d timeouts=%0d", total, failures, timeouts);
    $finish;
  end
endmodule
`;
}

export function caseFile(program: TypedProgram, cases: readonly Case[]): string {
  const index = new Map(program.functions.map((f, i) => [f.name, i] as const));
  return `${cases
    .map((c) => {
      const inw = c.input ?? [];
      const outw = c.expectedOutput ?? [];
      return `${index.get(c.functionName)} ${c.args.length} ${c.args.map(hex).join(' ')} ${hex(c.expected)} ${inw.length} ${inw.map((w) => w.toString(16)).join(' ')} ${outw.length} ${outw.map((w) => w.toString(16)).join(' ')}`.replace(
        / {2,}/g,
        ' ',
      );
    })
    .join('\n')}\n`;
}

async function main(): Promise<void> {
  const program = generateCorpus(CORPUS_SEED);
  const excluded = 0;
  const countDivisors = (p: TypedProgram): { literal: number; variable: number } => {
    let literal = 0;
    let variable = 0;
    for (const fn of p.functions)
      for (const node of fn.nodes) {
        if (node.op !== 'div' && node.op !== 'rem') continue;
        if (node.args[1]?.kind === 'u32') literal += 1;
        else variable += 1;
      }
    return { literal, variable };
  };
  const cases = generateCases(program);
  const sv = compile(program, 'sv').text;
  const iverilog = findIverilog();
  const vvp = findVvp();
  const yosys = findYosys();
  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    functions: program.functions.length,
    sequentialFunctions: program.functions.filter(needsSequential).length,
    excludedIoFunctions: excluded,
    inputCases: cases.length,
    tools: {
      iverilog: iverilog.version ?? null,
      vvp: vvp.version ?? null,
      yosys: yosys.version ?? null,
    },
    divisors: {
      beforeOptimize: countDivisors(program),
      afterOptimize: countDivisors(optimize(program).program),
      meaning:
        'div/rem nodes over the 48-function corpus split by divisor kind: literal (u32 constant operand) versus variable (param or node operand). Counted before and after optimize (which folds /1, %1 and strength-reduces literal powers of two to shr/and). Every remaining div/rem, either kind, is emitted as the shared 32-cycle a0_udiv unit.',
    },
    stagesRun: [] as string[],
    stagesNotRun: [
      'FPGA place-and-route',
      'ASIC synthesis with a real cell library',
      'timing closure',
      'area/power measurement',
      'real clock-domain timing (simulation is zero-delay RTL)',
    ],
  };
  const stagesRun = report.stagesRun as string[];

  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'module.sv'), sv, 'utf8');
    await writeFile(join(dir, 'tb.sv'), testbench(program), 'utf8');
    await writeFile(join(dir, 'cases.txt'), caseFile(program, cases), 'utf8');

    if (iverilog.path === undefined || vvp.path === undefined) {
      report.simulation = { status: 'blocked', detail: 'iverilog/vvp not found' };
    } else {
      const start = performance.now();
      const comp = runTool(
        iverilog.path,
        ['-g2012', '-Wall', '-o', 'sim.vvp', 'module.sv', 'tb.sv'],
        { cwd: dir },
      );
      if (!comp.ok) {
        report.simulation = {
          status: 'failed',
          detail: 'iverilog compile failed',
          stderr: comp.stderr.slice(0, 3000),
        };
      } else {
        const sim = runTool(vvp.path, ['-n', 'sim.vvp'], { cwd: dir, timeoutMs: 600_000 });
        const m = /A0SIM total=(\d+) failures=(\d+) timeouts=(\d+)/.exec(sim.stdout);
        const total = m ? Number(m[1]) : 0;
        const failures = m ? Number(m[2]) : -1;
        const timeouts = m ? Number(m[3]) : -1;
        const status =
          sim.ok && m && failures === 0 && timeouts === 0 && total === cases.length
            ? 'passed'
            : 'failed';
        const cyclesPerModule: Record<
          string,
          { cases: number; totalCycles: number; meanCycles: number }
        > = {};
        for (const c of sim.stdout.matchAll(/A0CYC fn=(\d+) cases=(\d+) cycles=(\d+)/g)) {
          const fn = program.functions[Number(c[1])];
          const n = Number(c[2]);
          const totalCycles = Number(c[3]);
          if (fn !== undefined)
            cyclesPerModule[`a0_${fn.name}`] = {
              cases: n,
              totalCycles,
              meanCycles: n === 0 ? 0 : totalCycles / n,
            };
        }
        report.simulation = {
          status,
          cases: total,
          failures,
          timeouts,
          cyclesPerModule,
          detail:
            'Icarus Verilog -g2012 RTL simulation of every emitted module against BigInt-oracle cases (pure modules zero-delay; clocked modules driven by start/done, io by valid/ready handshakes).',
          elapsedMs: performance.now() - start,
          log:
            status === 'passed'
              ? undefined
              : `${sim.stdout.slice(0, 3000)}\n${sim.stderr.slice(0, 2000)}`,
          warnings: comp.stderr.trim().length > 0 ? comp.stderr.slice(0, 2000) : undefined,
        };
        stagesRun.push('RTL simulation (Icarus Verilog)');
      }
    }

    if (yosys.path === undefined) {
      report.synthesis = { status: 'blocked', detail: 'yosys not found' };
    } else {
      const start = performance.now();
      const script =
        'read_verilog -sv module.sv; hierarchy -check; proc; opt; synth -noabc; tee -q -o stat.json stat -json; check -assert'; // -noabc keeps the routine gate fast (~8 s). With the clocked divider, full `synth` (ABC) completes for the whole corpus in ~45 s (measured 2026-09-29); before it, single-cycle div/rem cones of 500-1750 gate levels stalled ABC for minutes.
      await writeFile(join(dir, 'synth.ys'), `${script.replace(/; /g, '\n')}\n`, 'utf8');
      const r = runTool(yosys.path, ['-q', '-s', 'synth.ys'], { cwd: dir, timeoutMs: 600_000 });
      if (!r.ok) {
        report.synthesis = {
          status: 'failed',
          detail: 'yosys synth failed',
          stderr: (r.stderr || r.stdout).slice(0, 3000),
        };
      } else {
        const { readFile } = await import('node:fs/promises');
        const stat = JSON.parse(await readFile(join(dir, 'stat.json'), 'utf8')) as {
          modules?: Record<string, { num_cells?: number; num_wires?: number }>;
        };
        const modules = Object.fromEntries(
          Object.entries(stat.modules ?? {}).map(([name, m]) => [
            name.replace(/^\\/, ''),
            { cells: m.num_cells ?? null, wires: m.num_wires ?? null },
          ]),
        );
        report.synthesis = {
          status: 'passed',
          detail:
            'Yosys generic `synth -noabc` to internal gate-level cells (ABC logic optimization skipped to keep the gate fast; it completes in ~45 s for the corpus since division became a 32-cycle clocked unit); `check -assert` found no issues. Not technology-mapped to any FPGA/ASIC library; cell counts are relative complexity only.',
          elapsedMs: performance.now() - start,
          modules,
        };
        stagesRun.push('generic logic synthesis (Yosys synth -noabc + check)');
      }
    }
  });

  await mkdir('results', { recursive: true });
  await writeReport(join('results', 'hardware.json'), report);
  process.stdout.write(
    `${JSON.stringify({ simulation: report.simulation, synthesisStatus: (report.synthesis as { status: string }).status, stagesRun }, null, 2)}\n`,
  );
  const failed = [report.simulation, report.synthesis].some(
    (s) => (s as { status: string }).status === 'failed',
  );
  process.exit(failed ? 1 : 0);
}

// Run only when executed directly so the testbench generator can be imported by other tools.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly)
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
