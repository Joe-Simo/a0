/**
 * .NET execution evidence (Gate 8): the corpus (including io functions) emitted as C#,
 * built with the .NET SDK (Release), and executed against the BigInt oracle through a
 * stdin driver identical in protocol to the C and Java drivers. Writes results/dotnet.json.
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { TypedProgram, Value } from '../src/core.js';
import { CS_CLASS, emitCSharp } from '../src/dotnet.js';
import { runTool, withTempDir } from '../src/toolchain.js';
import {
  type Case,
  generateCases,
  generateCorpus,
  hasIoParam,
  isDriverCallable,
} from './corpus.js';

const fmt = (v: Value): string => (typeof v === 'boolean' ? (v ? '1' : '0') : String(v));

function findDotnet(): string | undefined {
  const candidates = [
    process.env.A0_DOTNET,
    `${process.env.HOME ?? ''}/.dotnet/dotnet`,
    '/usr/local/share/dotnet/dotnet',
  ];
  return candidates.find((c) => c !== undefined && c.length > 0 && existsSync(c));
}

function driver(program: TypedProgram): string {
  const dispatch = program.functions.map((fn, i) => {
    if (!isDriverCallable(fn)) return `        case ${i}: sb.Append("skip\\n"); break;`;
    const io = hasIoParam(fn);
    const scalars = io ? fn.params.slice(0, -1) : fn.params;
    const args = scalars
      .map((t, p) => (t === 'u32' ? `uint.Parse(tok[${p + 1}])` : `tok[${p + 1}] == "1"`))
      .concat(io ? ['io'] : [])
      .join(', ');
    const call = `${CS_CLASS}.${fn.name}(${args})`;
    const print = fn.result === 'u32' ? `sb.Append(${call});` : `sb.Append(${call} ? "1" : "0");`;
    const setup = io
      ? `int nin = int.Parse(tok[${scalars.length + 1}]); var inw = new uint[nin]; for (int k = 0; k < nin; k++) inw[k] = uint.Parse(tok[${scalars.length + 2} + k]); var io = new ${CS_CLASS}.A0Io(inw); `
      : '';
    const flush = io
      ? ` for (int k = 0; k < io.NOutput; k++) { sb.Append(' '); sb.Append(io.Output[k]); }`
      : '';
    return `        case ${i}: { ${setup}${print}${flush} sb.Append('\\n'); break; }`;
  });
  return `using System;
using System.IO;
using System.Text;
public static class Driver {
  public static void Main() {
    var sb = new StringBuilder();
    string? line;
    while ((line = Console.In.ReadLine()) != null) {
      var tok = line.Trim().Split(' ');
      if (tok.Length < 1 || tok[0].Length == 0) continue;
      switch (int.Parse(tok[0])) {
${dispatch.join('\n')}
        default: sb.Append("?\\n"); break;
      }
    }
    Console.Out.Write(sb.ToString());
  }
}
`;
}

function expectedLine(c: Case): string {
  return c.expectedOutput === undefined
    ? fmt(c.expected)
    : [fmt(c.expected), ...c.expectedOutput.map(String)].join(' ');
}

async function main(): Promise<void> {
  const program = generateCorpus();
  const cases = generateCases(program);
  const index = new Map(program.functions.map((f, i) => [f.name, i] as const));
  const dotnet = findDotnet();
  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    functions: program.functions.length,
    inputCases: cases.length,
    scope:
      'Corpus emitted as C# (uint semantics), built Release with the .NET SDK, executed through a stdin driver, compared with the BigInt oracle.',
  };
  if (dotnet === undefined) {
    report.status = 'blocked';
    report.detail = 'dotnet SDK not found (set A0_DOTNET or install to ~/.dotnet)';
  } else {
    const start = performance.now();
    await withTempDir(async (dir) => {
      await writeFile(join(dir, `${CS_CLASS}.cs`), emitCSharp(program), 'utf8');
      await writeFile(join(dir, 'Driver.cs'), driver(program), 'utf8');
      await writeFile(
        join(dir, 'a0.csproj'),
        `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>net10.0</TargetFramework>\n    <Nullable>enable</Nullable>\n    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>\n    <ImplicitUsings>disable</ImplicitUsings>\n  </PropertyGroup>\n</Project>\n`,
        'utf8',
      );
      const env = {
        ...process.env,
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        DOTNET_NOLOGO: '1',
        DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
      };
      const build = runTool(
        dotnet,
        ['build', '-c', 'Release', '-o', join(dir, 'out'), '--nologo'],
        { cwd: dir, env, timeoutMs: 600_000 },
      );
      const version = runTool(dotnet, ['--version'], { env, timeoutMs: 30_000 }).stdout.trim();
      if (!build.ok) {
        report.status = 'failed';
        report.detail = `dotnet build failed: ${(build.stdout + build.stderr).slice(-3000)}`;
        report.tool = version;
        return;
      }
      const input = `${cases
        .map((c) => {
          const tokens = [String(index.get(c.functionName)), ...c.args.map(fmt)];
          if (c.input !== undefined) tokens.push(String(c.input.length), ...c.input.map(String));
          return tokens.join(' ');
        })
        .join('\n')}\n`;
      // Run through the SDK host so a user-local runtime (~/.dotnet) is found without DOTNET_ROOT.
      const exec = runTool(dotnet, [join(dir, 'out', 'a0.dll')], {
        cwd: dir,
        env,
        input,
        timeoutMs: 600_000,
      });
      if (!exec.ok) {
        report.status = 'failed';
        report.detail = `execution failed: ${exec.stderr.slice(0, 2000)}`;
        report.tool = version;
        return;
      }
      const actual = exec.stdout.trim().split('\n');
      const failures: string[] = [];
      cases.forEach((c, i) => {
        if (actual[i]?.trim() !== expectedLine(c)) {
          failures.push(
            `${c.functionName}(${c.args.map(fmt).join(',')}) expected ${expectedLine(c)} got ${actual[i] ?? '<missing>'}`,
          );
        }
      });
      report.status = failures.length === 0 ? 'passed' : 'failed';
      report.failures = failures.slice(0, 20);
      report.tool = version;
      report.detail = `C# built with .NET SDK ${version} (Release, warnings as errors) and executed; ${cases.length} cases incl. io streams.`;
      report.elapsedMs = performance.now() - start;
    });
  }
  await mkdir('results', { recursive: true });
  await writeFile(join('results', 'dotnet.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `${JSON.stringify({ status: report.status, tool: report.tool, detail: String(report.detail).slice(0, 1200), failures: (report.failures as string[] | undefined)?.slice(0, 5) }, null, 2)}\n`,
  );
  process.exit(report.status === 'passed' ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
