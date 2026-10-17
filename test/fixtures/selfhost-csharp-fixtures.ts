import assert from 'node:assert/strict';
import { checkedCases } from './checked-ops-fixtures.js';

export const CSHARP_ABI_SOURCE = `fn update u32x3 -> (u32x3,u32x3)
a set p0 0 9
r rec p0 a
ret r
end
fn echo io -> (u32,io)
a read p0
v at a 0
t at a 1
w write t v
r rec v w
ret r
end
fn cs_io_step io u32 -> io
w write p0 p1
ret w
end
fn stream io -> io
r fold cs_io_step 1050 p0
ret r
end
fn class u32 -> u32
r add p0 1
ret r
end
fn zero u32 -> (u32,u32)
a div p0 0
b rem p0 0
r rec a b
ret r
end
fn cget u32 -> (u32,bool)
a arr 7 8 9
r cget a p0
ret r
end
`;

/** Literal checked expectations come from the shared independent BigInt oracle. */
export function csharpOracleDriver(): {
  source: string;
  checked: number;
  abi: number;
} {
  const tests = checkedCases().map((row, i) => {
    assert.ok(row.args.every((v) => typeof v === 'number' || typeof v === 'boolean'));
    const val = (v: unknown) => (typeof v === 'boolean' ? (v ? 'true' : 'false') : `${v}u`);
    return `    Check(A0Module.@${row.functionName}(${row.args.map(val).join(',')}) == ${val(row.expected)}, "checked${i}");`;
  });
  const extra = `    uint[] input = { 1u, 2u, 3u };
    var changed = A0Module.@update(input);
    Check(object.ReferenceEquals(changed.f0, input), "original array reference");
    Check(!object.ReferenceEquals(changed.f1, input), "updated array clone");
    Check(input[0] == 1u && changed.f1[0] == 9u && changed.f1[2] == 3u, "array values");
    Check(A0Module.@class(uint.MaxValue) == 0u, "keyword name / checked project wrapping");
    var zero = A0Module.@zero(2147483648u);
    Check(zero.f0 == uint.MaxValue && zero.f1 == 2147483648u, "literal zero division/rem");
    var cget = A0Module.@cget(uint.MaxValue);
    Check(cget.f0 == 0u && !cget.f1, "checked raw unsigned index");
    var io = new A0Module.A0Io(new uint[] { 9u });
    var first = A0Module.@echo(io);
    Check(first.f0 == 9u && object.ReferenceEquals(first.f1, io), "IO identity/read");
    var second = A0Module.@echo(io);
    Check(second.f0 == 0u && io.Position == 1 && io.NOutput == 2 && io.Output[0] == 9u && io.Output[1] == 0u, "exhausted input once");
    var cap = new A0Module.A0Io(System.Linq.Enumerable.ToArray(System.Linq.Enumerable.Range(0, 300).Select(v => (uint)v)));
    Check(cap.NInput == 256 && cap.Input[255] == 255u, "input cap");
    var streamed = A0Module.@stream(cap);
    Check(object.ReferenceEquals(streamed, cap) && cap.NOutput == 1024 && cap.Output[1023] == 1023u, "output cap / fold");`;
  const source = `using System.Linq;
public static class Driver {
  static int checks;
  static void Check(bool condition, string label) { if (!condition) throw new System.Exception(label); checks++; }
  public static void Main() {
${tests.join('\n')}
${extra}
    System.Console.WriteLine(checks);
  }
}
`;
  return {
    source,
    checked: tests.length,
    abi: (extra.match(/Check\(/g) ?? []).length,
  };
}
