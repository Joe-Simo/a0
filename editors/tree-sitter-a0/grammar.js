/**
 * @file Tree-sitter grammar for A0 (DESIGN.md section 4, "Grammar").
 * @license MIT
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

// Fixed-arity operations (src/core.ts OP_ARITY); `udiv`/`urem` are the accepted aliases of div/rem.
const OPS_BY_ARITY = {
  1: ['mov', 'read'],
  2: [
    'add', 'sub', 'mul', 'and', 'or', 'xor', 'shl', 'shr',
    'eq', 'ne', 'lt', 'le', 'gt', 'ge',
    'get', 'at', 'write', 'div', 'rem', 'udiv', 'urem', 'puts',
  ],
  3: ['select', 'set', 'put'],
};

module.exports = grammar({
  name: 'a0',

  extras: ($) => [/[ \t\r]/, $.comment],

  word: ($) => $.identifier,

  rules: {
    // file = use* function+
    source_file: ($) =>
      seq(
        repeat($._newline),
        repeat(seq($.use_declaration, repeat1($._newline))),
        $.function_definition,
        repeat(seq(repeat1($._newline), $.function_definition)),
        repeat($._newline),
      ),

    // use = "use" quoted_relative_path NEWLINE
    use_declaration: ($) => seq('use', field('path', $.string)),

    // function = "fn" name type* "->" type NEWLINE instruction* "ret" operand NEWLINE "end"
    function_definition: ($) =>
      seq(
        'fn',
        field('name', $.identifier),
        field('parameters', optional($.parameter_types)),
        '->',
        field('result', $._type),
        repeat1($._newline),
        repeat(seq($.instruction, repeat1($._newline))),
        $.return_statement,
        repeat1($._newline),
        'end',
      ),

    parameter_types: ($) => repeat1($._type),

    // "ret" operand, or the sugar "ret OP ARGS" for a fresh node followed by ret of it.
    return_statement: ($) => seq('ret', choice(field('value', $._operand), $._expression)),

    instruction: ($) => seq(field('id', $.identifier), $._expression),

    _expression: ($) =>
      choice(
        $.operation,
        $.call_expression,
        $.direct_call_expression,
        $.fold_expression,
        $.loop_expression,
        $.aggregate_expression,
        $.text_expression,
      ),

    // id operation operand{operation_arity}
    operation: ($) =>
      choice(
        ...Object.entries(OPS_BY_ARITY).map(([arity, ops]) =>
          seq(
            field('operator', alias(choice(...ops), $.operator)),
            ...Array.from({ length: Number(arity) }, () => field('argument', $._operand)),
          ),
        ),
      ),

    // arr / rec take one or more operands
    aggregate_expression: ($) =>
      seq(
        field('operator', alias(choice('arr', 'rec'), $.operator)),
        repeat1(field('argument', $._operand)),
      ),

    // id "call" function_name operand*
    call_expression: ($) =>
      seq('call', field('function', $.identifier), repeat(field('argument', $._operand))),

    // id function_name operand*   (direct call: function_name is not an op)
    direct_call_expression: ($) =>
      seq(field('function', $.identifier), repeat1(field('argument', $._operand))),

    // id "fold" function_name count init operand*
    fold_expression: ($) =>
      seq(
        'fold',
        field('function', $.identifier),
        field('count', $._operand),
        field('init', $._operand),
        repeat(field('argument', $._operand)),
      ),

    // id "loop" predicate_name function_name count init operand*
    loop_expression: ($) =>
      seq(
        'loop',
        field('predicate', $.identifier),
        field('function', $.identifier),
        field('count', $._operand),
        field('init', $._operand),
        repeat(field('argument', $._operand)),
      ),

    // id "text" "..."  (sugar for arr of UTF-8 bytes)
    text_expression: ($) => seq('text', field('value', $.string)),

    // operand = earlier_id | parameter | u32_literal | "true" | "false"
    _operand: ($) => choice($.identifier, $.parameter, $.integer, $.boolean),

    // type = "u32" | "bool" | "io" | type "x" length | "(" type ("," type)* ")"
    _type: ($) => choice($.primitive_type, $.array_type, $.tuple_type),
    primitive_type: (_) => token(prec(2, /u32|bool|io/)),
    array_type: ($) =>
      choice(
        token(prec(2, /(u32|bool|io)(x[0-9]+)+/)),
        seq(field('element', $.tuple_type), token.immediate(/(x[0-9]+)+/)),
      ),
    tuple_type: ($) => seq('(', $._type, repeat(seq(token.immediate(','), $._type)), token.immediate(')')),

    parameter: (_) => token(prec(1, /p(0|[1-9][0-9]*)/)),
    integer: (_) => /0|[1-9][0-9]*/,
    boolean: (_) => choice('true', 'false'),
    identifier: (_) => /[a-z][a-z0-9_]*/,
    string: (_) => /"([^"\\\n]|\\.)*"/,
    comment: (_) => token(seq('#', /[^\n]*/)),
    _newline: (_) => /\n/,
  },
});
