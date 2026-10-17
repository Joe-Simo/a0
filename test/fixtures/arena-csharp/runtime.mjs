import assert from 'node:assert/strict';
import { CHECKED_SOURCE } from '../../../dist/test/fixtures/checked-ops-fixtures.js';
import {
  CSHARP_ABI_SOURCE,
  csharpOracleDriver,
} from '../../../dist/test/fixtures/selfhost-csharp-fixtures.js';

const extra = `fn strict_update u32x3 u32 io -> io
w write p2 5
a set p0 p1 9
v get a 0
t write w v
ret t
end
fn trap_input io -> io
w write p0 7
r read w
v at r 0
t at r 1
w2 write t v
r2 read w2
t2 at r2 1
ret t2
end
fn bad_body u32 u32 -> u32
r div p0 0
ret r
end
fn nested u32 u32 -> u32
original_inner fold bad_body 1 p0
ret original_inner
end
fn outer u32 -> u32
original_outer fold nested 1 p0
ret original_outer
end
fn bad_pred u32 u32 -> bool
z div p0 0
r eq z 0
ret r
end
fn guarded u32 -> u32
original_loop loop bad_pred bad_body 3 p0
ret original_loop
end
fn counter_body u32 u32 -> u32
d sub p1 1
r div p0 d
ret r
end
fn counter u32 -> u32
original_counter fold counter_body 3 p0
ret original_counter
end
`;
const trapHelper = `  static A0Module.A0Trap Trap(System.Action call, string id, string kind, string fn, string? at, string? trip, string chain) {
    try { call(); } catch (A0Module.A0Trap t) {
      string fix = kind=="bounds"?"keep the index below the length (check it, or use cget for a total read)":kind=="divzero"?"test the divisor first, or use cdiv/crem, which return (0,false) for a zero divisor":"supply more input words, or stop reading when the input is exhausted";
      Check(t.Id==id && t.Kind==kind && t.Fn==fn && t.At==at && t.Trip==trip && string.Join(">",t.Chain)==chain && t.Fix==fix && t.Line()=="runtime: trap "+kind+" fn="+fn+" at="+(at??"-")+" trip="+(trip??"-")+" chain="+chain+" fix: "+fix, "exact strict trap"); return t;
    }
    throw new System.Exception("missing strict trap");
  }
`;
const strictChecks = `    uint[] original = { 1u,2u,3u }; var boundsIo = new A0Module.A0Io(System.Array.Empty<uint>());
    Trap(()=>A0Module.@strict_update(original,uint.MaxValue,boundsIo),"A0710","bounds","strict_update",null,null,"strict_update");
    Check(original[0]==1u && original[1]==2u && original[2]==3u && boundsIo.NOutput==1 && boundsIo.Output[0]==5u,"strict bounds before clone/write");
    var exhaustedIo = new A0Module.A0Io(new uint[]{9u});
    Trap(()=>A0Module.@trap_input(exhaustedIo),"A0712","input","trap_input",null,null,"trap_input");
    Check(exhaustedIo.Position==1 && exhaustedIo.NOutput==2 && exhaustedIo.Output[0]==7u && exhaustedIo.Output[1]==9u,"IO effects exactly once before input trap");
    Trap(()=>A0Module.@outer(7u),"A0711","divzero","bad_body","nested.original_inner","0","outer>nested>bad_body");
    Trap(()=>A0Module.@guarded(7u),"A0711","divzero","bad_pred","guarded.original_loop","0","guarded>bad_pred");
    Trap(()=>A0Module.@counter(7u),"A0711","divzero","counter_body","counter.original_counter","1","counter>counter_body");
    Check(A0Module.@class(0u)==1u,"trap stack reset before next public call");
`;
export function targetFixture(strict) {
  const driver = csharpOracleDriver();
  let text = driver.source;
  let expected = driver.checked + driver.abi;
  if (strict) {
    text = text.replace(
      '  public static void Main() {',
      `${trapHelper}  public static void Main() {`,
    );
    text = text.replace(
      '    var zero = A0Module.@zero(2147483648u);\n    Check(zero.f0 == uint.MaxValue && zero.f1 == 2147483648u, "literal zero division/rem");',
      '    Trap(()=>A0Module.@zero(2147483648u),"A0711","divzero","zero",null,null,"zero");',
    );
    text = text.replace(
      '    var second = A0Module.@echo(io);\n    Check(second.f0 == 0u && io.Position == 1 && io.NOutput == 2 && io.Output[0] == 9u && io.Output[1] == 0u, "exhausted input once");',
      '    Trap(()=>A0Module.@echo(io),"A0712","input","echo",null,null,"echo");',
    );
    text = text.replace(
      '    System.Console.WriteLine(checks);',
      `${strictChecks}    System.Console.WriteLine(checks);`,
    );
    expected += 8;
  }
  if (strict) {
    assert.ok(text.includes('Trap(()=>A0Module.@zero('));
    assert.ok(text.includes('Trap(()=>A0Module.@echo('));
    assert.ok(!text.includes('var zero ='));
    assert.ok(!text.includes('var second ='));
  }
  assert.equal(expected, strict ? 2374 : 2366);
  return {
    source: (strict ? 'profile strict\n' : '') + CHECKED_SOURCE + CSHARP_ABI_SOURCE + extra,
    driver: text,
    expected,
  };
}
