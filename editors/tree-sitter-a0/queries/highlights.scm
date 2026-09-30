; Keywords
["fn" "end" "use"] @keyword
"ret" @keyword.return
["call" "fold" "loop" "text"] @keyword.operator
"->" @punctuation.delimiter
["(" ")"] @punctuation.bracket
"," @punctuation.delimiter

; Operations
(operator) @operator

; Functions
(function_definition name: (identifier) @function)
(call_expression function: (identifier) @function.call)
(direct_call_expression function: (identifier) @function.call)
(fold_expression function: (identifier) @function.call)
(loop_expression predicate: (identifier) @function.call)
(loop_expression function: (identifier) @function.call)

; Values
(parameter) @variable.parameter
(identifier) @variable
(integer) @number
(boolean) @boolean
(use_declaration path: (string) @string.special.path)
(string) @string

; Types
(primitive_type) @type.builtin
(array_type) @type
(tuple_type) @type

(comment) @comment
