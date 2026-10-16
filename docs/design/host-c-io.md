# Embedding C with host word streams

`compile(program, 'c', { cIo: 'host' })` connects A0's existing `io` operations
to host storage or streams. It changes the C embedding interface; source syntax,
type checking, token ownership and operation order remain the same. The default
fixed-capacity C interface is unchanged.

Before including the generated module, define `struct a0_io` and two hooks:

```c
#include <stdbool.h>
#include <stdint.h>

struct a0_io {
  void *context;
};

static bool read_word(struct a0_io *token, uint32_t *out);
static void write_word(struct a0_io *token, uint32_t word);

#define A0_IO_READ(token, out) read_word((token), (out))
#define A0_IO_WRITE(token, word) write_word((token), (word))
#include "module.c"
```

`READ` returns true and writes a full `uint32_t` when input is available. False
means end of input: canonical semantics return zero; the strict profile raises
the usual input trap with its function, node and iteration context. A false read
need not initialize `out`. `WRITE` receives each word in source evaluation order.
`puts` writes the byte length followed by the UTF-8 bytes, just as with buffered
I/O. Every operation returns the original token pointer.

Keep the token and its context alive for the entire call. Hooks must evaluate
their arguments once and must not reenter the module. They may call host
functions directly or dispatch through callbacks in the context. Capacities are
the host's responsibility for this interface; `ioInputCapacity` and
`ioOutputCapacity` describe the default buffered interface.

[The native tests](../../test/c-host-io.test.ts) compare streamed results and
strict input traps with the reference interpreter, including output beyond the
default buffer, full unsigned words, a false read that writes an unrelated
value, UTF-8 text and token identity. They run both compiler optimization modes
with C optimization disabled and enabled under undefined-behavior checks.
