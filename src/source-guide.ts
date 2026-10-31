/** The candidate primer shared by generated projects and executable guide tests. */
export const SOURCE_STARTER = `fn hello
ex 7 -> 15
x mul A 2
y add x 1
ret y
end
`;

export const SOURCE_EXAMPLES = `Examples (every block is checked and its contracts executed):
\`\`\`a0
${SOURCE_STARTER}\`\`\`
\`\`\`a0
fn arrays
ex 3 -> 9
v [A,7]
w set v 1 9
r get w 1
ret r
end
fn records
ex 4 -> 5
v (A,true)
w put v 0 5
r at w 0
ret r
end
\`\`\`
\`\`\`a0
fn step _ _ -> _
r add A B
ret r
end
fn sum
ex 4 -> 6
r fold step A 0
ret r
end
fn below _ _ -> bool
r lt B 2
ret r
end
fn limited
ex 4 -> 1
r loop below step A 0
ret r
end
\`\`\`
\`\`\`a0
profile strict
fn half
ex 8 -> 4
pre ne A 0
post le r A
r div A 2
ret r
end
\`\`\`
\`\`\`a0
fn echo io -> io
v read A
x at v 0
t at v 1
u write t x
ret u
end
\`\`\`
`;

export const SOURCE_GUIDE = `A0 candidate grammar. Internal migration: public defaults have not changed.
From project root use node .a0/cli.mjs for check, run, emit, hook, mcp, lsp, migrate, init.
Compiler moved? Run node <compiler>/dist/src/source-cli.js init <project> to rebind.
Bare a0 uses the shipped reader. Legacy-only input must be migrated to a new destination;
--dense is import-only. Sealed source needs an authorized unlock session, never file bypass.

Program: optional use "relative/file.a0", then earlier-defined functions. No forward calls/recursion.
Function: fn NAME [T... -> T], lines ID OP OPERANDS, ret OPERAND (or ret OP OPERANDS), end.
Params A B ... Z then p26 p27 ...; IDs lowercase. Omit signatures for inferred word types only.
Types: _ (u32), bool, io, _x4, (_,bool); nest without spaces. # comment. Operands: param,
earlier ID, decimal word, true/false. No nested operations. Aggregates are immutable values.
OPS
mov x; add/sub/mul wrap mod 2^32; and/or/xor bitwise words or logical bools.
<< / >> shift by n&31, >> unsigned. div a 0 = 4294967295; rem a 0 = a.
eq/ne words or bools; lt/le/gt/ge unsigned words -> bool; select c x y computes both arms.
NAME args calls an earlier function; call NAME args disambiguates operation-named functions.
fold F n s args: s=F(s,index,args) for index 0..n-1; F returns state's type.
loop P F n s args stops before a trip when P(s,index,args) is false; P returns bool.
[a,b] array; (a,b) record; [7*3] repeated literal; text "abc" UTF8 bytes.
get a i / set a i v use i modulo length; at r k / put r k v use literal field k.
read t -> (_,io); write t word / puts t array -> io. Each io token used once, at most one
io param; no io arrays/select. profile strict selects trap semantics, not another grammar.
ex INPUTS -> RESULT, pre CONDITION, post CONDITION (r=result): executable contracts.
EDITS
Bound MCP: a0_open/a0_program -> a0_apply -> a0_check/a0_run -> a0_save. Reply with exact handle,
then ID OP ... (insert/replace), ID OP ... @ OTHER (insert after), -ID, or ret X.
Program edits: fn ... end or -fn NAME. Rejection preserves revision; save accepted edits only.
Views, edits and output use this grammar. Apply justified diagnostic fixes; check again.
EXAMPLE
\`\`\`a0
${SOURCE_STARTER}\`\`\`
Optional worked examples: .a0/EXAMPLES.md (same grammar).
Syntax tested; model accuracy/cost, native frontend cost and full-platform cutover gates remain.
`;
