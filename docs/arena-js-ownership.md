# Arena JavaScript ownership

The original-source A0 JavaScript writer plans when an aggregate can be updated
in place and when an iteration must snapshot its initial state. The public value
boundary retains caller ownership. A private iteration variant owns its state;
a deep variant additionally owns disjoint scalar typed-array fields of a flat
record. Zero trips, early exits, repeated array fields, borrowed extras and
escaped aggregate holders retain immutable source value semantics.

The A0 planner computes direct-use and aggregate-borrow extrema from the emitted
full-word context. Duplicate uses and returned values have separate facts. A
field projection becomes exclusive only for a proved deep record with unique
field reads and no whole-record use. Deep record return storage is reused after
its source expressions have been captured as SSA values, preserving field swaps.
There is no host ownership plan or target fallback.

Flat typed-array literals use one zeroed typed allocation followed by scalar
stores. Literal zero stores are omitted. This avoids a temporary plain array and
a JavaScript call-argument limit. Scalar public bodies retain direct guards, and
canonical indices retain literal reduction and power-of-two masks.

The changed native A0 compiler passed the existing 9,327 semantic comparisons,
41 public ABI calls, 18 strict checks, 51 source-verification/resource controls and
seven full-word boundary cases. Eighteen unchanged lifecycle/deep fixtures match
the reference compiler's allocation, snapshot and copied-element counts exactly;
14 handwritten alias controls match independent BigInt value models. Four
independent guard mutations produce the predicted wrong results. All 29 execution
kernels also match handwritten JavaScript across 32 inputs and match reference
O0 allocation counts at a separate input. These are correctness and allocation
observations, with no timing claim.

The proof uses original unoptimized A0BC inputs. Optimizer A0BO consumption and
strict site/may-trap proof elision remain pending. Equal allocation counts do not
establish full runtime-performance parity. The projection scan and dependency
rounds can be quadratic; no linear compilation-time claim is made.
