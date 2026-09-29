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
import { compile } from '../src/backends.js';
import type { TypedProgram, Value } from '../src/core.js';
import { findIverilog, findVvp, findYosys, runTool, withTempDir } from '../src/toolchain.js';
import { type Case, generateCases, generateCorpus, hasScalarSignature } from './corpus.js';

const hex = (v: Value): string => (typeof v === 'boolean' ? (v ? '1' : '0') : v.toString(16));

function testbench(program: TypedProgram): string {
  const insts = program.functions.map((fn, i) => {
    if (!hasScalarSignature(fn))
      return `  // ${fn.name}: aggregate signature, exercised through instantiating modules`;
    const decls = fn.params.map((t, p) => `  logic ${t === 'u32' ? '[31:0] ' : ''}in_${i}_${p};`);
    const out = `  logic ${fn.result === 'u32' ? '[31:0] ' : ''}out_${i};`;
    const ports = [...fn.params.map((_, p) => `.p${p}(in_${i}_${p})`), `.result(out_${i})`].join(
      ', ',
    );
    return [...decls, out, `  a0_${fn.name} u_${i} (${ports});`].join('\n');
  });
  const drive = program.functions.map((fn, i) => {
    if (!hasScalarSignature(fn)) return `        ${i}: begin $display("skip"); end`;
    const sets = fn.params.map((_, p) => `in_${i}_${p} = args[${p}];`).join(' ');
    return `        ${i}: begin ${sets} #1; got = out_${i}; end`;
  });
  return `\`timescale 1ns/1ps
module tb;
${insts.join('\n')}
  logic [31:0] args [0:63];
  logic [31:0] got;
  logic [31:0] expected;
  integer fd, idx, nargs, k, total, failures, rc;
  initial begin
    total = 0; failures = 0;
    fd = $fopen("cases.txt", "r");
    if (fd == 0) begin $display("cannot open cases.txt"); $finish; end
    while (!$feof(fd)) begin
      rc = $fscanf(fd, "%d %d", idx, nargs);
      if (rc != 2) break;
      for (k = 0; k < nargs; k = k + 1) rc = $fscanf(fd, "%h", args[k]);
      rc = $fscanf(fd, "%h", expected);
      got = 32'hxxxxxxxx;
      case (idx)
${drive.join('\n')}
        default: begin $display("bad index %0d", idx); $finish; end
      endcase
      total = total + 1;
      if (got !== expected) begin
        failures = failures + 1;
        if (failures <= 20) $display("FAIL fn=%0d args=%h,%h,%h,%h expected=%h got=%h", idx, args[0], args[1], args[2], args[3], expected, got);
      end
    end
    $display("A0SIM total=%0d failures=%0d", total, failures);
    $finish;
  end
endmodule
`;
}

function caseFile(program: TypedProgram, cases: readonly Case[]): string {
  const index = new Map(program.functions.map((f, i) => [f.name, i] as const));
  return `${cases.map((c) => `${index.get(c.functionName)} ${c.args.length} ${c.args.map(hex).join(' ')} ${hex(c.expected)}`).join('\n')}\n`;
}

async function main(): Promise<void> {
  const program = generateCorpus();
  const cases = generateCases(program);
  const sv = compile(program, 'sv').text;
  const iverilog = findIverilog();
  const vvp = findVvp();
  const yosys = findYosys();
  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    functions: program.functions.length,
    inputCases: cases.length,
    tools: {
      iverilog: iverilog.version ?? null,
      vvp: vvp.version ?? null,
      yosys: yosys.version ?? null,
    },
    stagesRun: [] as string[],
    stagesNotRun: [
      'FPGA place-and-route',
      'ASIC synthesis with a real cell library',
      'timing closure',
      'area/power measurement',
      'sequential/state logic (none exists in v0.1)',
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
        const m = /A0SIM total=(\d+) failures=(\d+)/.exec(sim.stdout);
        const total = m ? Number(m[1]) : 0;
        const failures = m ? Number(m[2]) : -1;
        const status =
          sim.ok && m && failures === 0 && total === cases.length ? 'passed' : 'failed';
        report.simulation = {
          status,
          cases: total,
          failures,
          detail:
            'Icarus Verilog -g2012 RTL simulation of every emitted module against BigInt-oracle cases (combinational, zero-delay).',
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
        'read_verilog -sv module.sv; hierarchy -check; proc; opt; synth; tee -q -o stat.json stat -json; check -assert';
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
            'Yosys generic `synth` to internal gate-level cells; `check -assert` found no issues. Not technology-mapped to any FPGA/ASIC library; cell counts are relative complexity only.',
          elapsedMs: performance.now() - start,
          modules,
        };
        stagesRun.push('generic logic synthesis (Yosys synth + check)');
      }
    }
  });

  await mkdir('results', { recursive: true });
  await writeFile(join('results', 'hardware.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `${JSON.stringify({ simulation: report.simulation, synthesisStatus: (report.synthesis as { status: string }).status, stagesRun }, null, 2)}\n`,
  );
  const failed = [report.simulation, report.synthesis].some(
    (s) => (s as { status: string }).status === 'failed',
  );
  process.exit(failed ? 1 : 0);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
