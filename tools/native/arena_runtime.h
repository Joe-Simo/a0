#ifndef A0_ARENA_RUNTIME_H
#define A0_ARENA_RUNTIME_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* A compiler-only IO adapter. It knows words, allocation handles and output,
 * never source syntax, token/type tables, chunks, or generated code. Ordinary
 * generated buffered IO is unchanged unless its wrapper explicitly selects
 * A0_COMPILER_READ/A0_COMPILER_WRITE and maps the token to this session.
 *
 * Example wrapper (the generated a0_io layout is not changed):
 *   static a0_arena_session *compiler_session;
 *   #define A0_COMPILER_READ(t) \
 *     ((void)(t), a0_runtime_read(compiler_session))
 *   #define A0_COMPILER_WRITE(t, v) \
 *     ((void)(t), a0_runtime_write(compiler_session, (v)))
 *   #include "emitter.c"
 *
 * One session is used by one invocation/thread at a time. Distinct sessions
 * have no shared mutable state. Reset and destroy release every allocation.
 */

#define A0_ARENA_MAGIC UINT32_C(0x41304152)
#define A0_ARENA_VERSION UINT32_C(1)
#define A0_ARENA_BULK_MAX UINT32_C(128)

enum a0_arena_op {
  A0_ARENA_ALLOC = 1,
  A0_ARENA_LOAD = 2,
  A0_ARENA_STORE = 3,
  A0_ARENA_EMIT = 4,
  A0_ARENA_FINISH = 5
};

enum a0_arena_status {
  A0_ARENA_OK = 0,
  A0_ARENA_PROTOCOL = 1,
  A0_ARENA_HANDLE = 2,
  A0_ARENA_RANGE = 3,
  A0_ARENA_ALLOCATION = 4,
  A0_ARENA_FINISHED = 5
};

typedef struct a0_arena_session a0_arena_session;

/* Budgets count u32 payload words; allocation metadata is separately bounded
 * by max_words because zero-word allocations are refused. Creation does not
 * allocate the payload budgets eagerly. NULL means the session allocation
 * itself failed. Reset retains the configured budgets.
 */
a0_arena_session *a0_arena_create(uint32_t max_words,
                                  uint32_t max_output_words);
void a0_arena_reset(a0_arena_session *session);
void a0_arena_destroy(a0_arena_session *session);

/* Writes form requests [op, argumentCount, arguments...]. Responses are
 * [status, payloadCount, payload...]. Create/reset queues the initial response
 * [OK, 2, MAGIC, VERSION], which must be consumed before writing a request.
 *
 * ALLOC(nwords) -> [handle]; nwords must be positive; handle 0 is invalid.
 * LOAD(handle, offset, count) -> [word...].
 * STORE(handle, offset, count, word...) -> [].
 * EMIT(count, word...) -> [].
 * FINISH(code) -> []; releases heap allocations, retaining output and code.
 *
 * LOAD/STORE/EMIT counts are at most 128. A zero count is valid; for LOAD/STORE
 * the offset may equal the allocation length in that case. All requests are
 * atomic. Bad handles/ranges/allocation exhaustion leave the session usable.
 * Requests completed after FINISH respond FINISHED without changing state.
 *
 * Unknown op, wrong argumentCount, counts inconsistent with payload, truncated
 * requests (a read before completion), reads without a reply, and new writes
 * before the previous reply is drained are sticky protocol failures until
 * reset. Unread reply words are retained and [PROTOCOL,0] follows them. Further
 * writes are ignored. Reading an exhausted failed session starts another
 * [PROTOCOL,0] frame. The host must require is_complete after the A0 call:
 * FINISH, no protocol failure, no partial request, and no unread reply words.
 *
 * The parser holds at most 131 argument words (STORE's 3+128); an argumentCount
 * beyond this, or beyond an op's permitted shape, is a protocol error before
 * any payload allocation. All uint32 words are preserved exactly.
 *
 * Callbacks require a non-NULL live session supplied explicitly by the wrapper.
 */
uint32_t a0_runtime_read(a0_arena_session *session);
void a0_runtime_write(a0_arena_session *session, uint32_t word);

bool a0_arena_protocol_failed(const a0_arena_session *session);
bool a0_arena_is_finished(const a0_arena_session *session);
bool a0_arena_is_complete(const a0_arena_session *session);
uint32_t a0_arena_finish_code(const a0_arena_session *session);
uint32_t a0_arena_allocated_words(const a0_arena_session *session);
uint32_t a0_arena_allocation_count(const a0_arena_session *session);
uint32_t a0_arena_output_count(const a0_arena_session *session);
const uint32_t *a0_arena_output(const a0_arena_session *session);

#ifdef __cplusplus
}
#endif

#endif
