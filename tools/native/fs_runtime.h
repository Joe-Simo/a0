#ifndef A0_PRIVATE_FS_RUNTIME_H
#define A0_PRIVATE_FS_RUNTIME_H
#include <stdbool.h>
#include <stdint.h>
#include "arena_runtime.h"
/* Optional generic POSIX OS transport; no source/graph/compiler decisions.
 * Initial reply [0,4,ARENA_MAGIC,1,FS_MAGIC,1]. Base operations1..5 unchanged.
 * Ops16realpath/17readfile/18stat use [pathHandle,start,length], op19cwd [].
 * String/file replies [transportStatus,3,errno,handle,nbytes].
 * STAT replies [transportStatus,4,errno,mode,sizeLow,sizeHigh].
 * An OS failure is errno!=0 with normal transport status0; runtime1..5
 * remain distinct. Successful bytes live in ordinary arena allocations.
 * All spans/bytes are raw; embedded NUL is invalid as an OS path argument.
 */
#define A0_FS_MAGIC UINT32_C(0x41304653)
#define A0_FS_VERSION UINT32_C(1)
typedef struct a0fs_session a0fs_session;
a0fs_session *a0fs_create(uint32_t max_words,uint32_t max_output_words);
void a0fs_destroy(a0fs_session *session);
uint32_t a0fs_read(a0fs_session *session);
void a0fs_write(a0fs_session *session,uint32_t word);
bool a0fs_is_complete(const a0fs_session *session);
bool a0fs_protocol_failed(const a0fs_session *session);
uint64_t a0fs_calls(const a0fs_session *session,uint32_t op);
uint32_t a0fs_allocated_words(const a0fs_session *session);
#endif
