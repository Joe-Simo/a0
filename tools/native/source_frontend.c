/* Generic memory/transport adapter. Source, typing and spec decisions execute in A0. */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "arena_runtime.c"

static a0_arena_session *session;
static struct a0_io *token;
#define A0_IO_READ(t, out) ((void)(t), *(out) = a0_runtime_read(session), true)
#define A0_IO_WRITE(t, v) ((void)(t), a0_runtime_write(session, (v)))
struct a0_io { uint32_t unused; };
#include "module.c"
#include "api.h"

static a0_io frontend_io;
static SV_STATE state;
static IR_STATE ir_state;
static uint32_t last_status, ir_value;
static bool ir_active;

static void send(uint32_t op, uint32_t n, const uint32_t *args) {
    a0_runtime_write(session, op);
    a0_runtime_write(session, n);
    for (uint32_t i = 0; i < n; i++) a0_runtime_write(session, args[i]);
}

static uint32_t reply(uint32_t expected) {
    uint32_t status = a0_runtime_read(session);
    uint32_t count = a0_runtime_read(session);
    if (status) return status;
    return count == expected ? 0 : 5;
}

static uint32_t start_session(uint32_t budget) {
    if (session) a0_arena_destroy(session);
    memset(&state, 0, sizeof state);
    memset(&ir_state, 0, sizeof ir_state);
    memset(&frontend_io, 0, sizeof frontend_io);
    ir_active = false;
    ir_value = 0;
    token = &frontend_io;
    session = a0_arena_create(budget, 0);
    if (!session) return last_status = 4;
    uint32_t status = reply(2);
    if (status) return last_status = status;
    (void)a0_runtime_read(session);
    (void)a0_runtime_read(session);
    return last_status = 0;
}

/* Both byte sources and structural IR use the same bounded arena upload protocol. */
static uint32_t upload(const void *input, uint32_t count, bool bytes) {
    uint32_t size = count ? count : 1;
    send(1, 1, &size);
    uint32_t status = reply(1);
    if (status) { last_status = status; return 0; }
    uint32_t handle = a0_runtime_read(session);
    for (uint32_t i = 0; i < count;) {
        uint32_t n = count - i > 128 ? 128 : count - i;
        uint32_t words[131] = { handle, i, n };
        for (uint32_t j = 0; j < n; j++)
            words[j + 3] = bytes ? ((const uint8_t *)input)[i + j] : ((const uint32_t *)input)[i + j];
        send(3, n + 3, words);
        status = reply(0);
        if (status) { last_status = status; return 0; }
        i += n;
    }
    return handle;
}

uint32_t frontend_abi(void) { return 3; }

/* Optional generic transport capability for a separate failure-only A0 renderer. */
#ifdef A0_FRONTEND_DIAGNOSTIC_PORTS
uintptr_t frontend_arena_token(void) { return (uintptr_t)session; }
#endif

static uint32_t parse_source(const uint8_t *source, uint32_t length, uint32_t budget, bool unit) {
    uint32_t status = start_session(budget);
    if (status) return status;
    uint32_t handle = upload(source, length, true);
    if (!handle) return last_status;
    if (unit) {
        FRONTEND_UNIT(state, token, handle, length);
    } else {
        FRONTEND_BEGIN(state, token, handle, length);
        while (state.f0.e[1] != 11) FRONTEND_RESUME(state, 97);
    }
    return last_status = FRONTEND_STATUS(state.f0);
}

uint32_t frontend_parse(const uint8_t *source, uint32_t length, uint32_t budget) {
    return parse_source(source, length, budget, false);
}

uint32_t frontend_parse_unit(const uint8_t *source, uint32_t length, uint32_t budget) {
    return parse_source(source, length, budget, true);
}

/* Trusted parsed-IR construction. Language identity and checking remain in A0. */
uint32_t frontend_ir_init(const uint8_t *source, uint32_t length, uint32_t budget, uint32_t strict) {
    uint32_t status = start_session(budget);
    if (status) return status;
    uint32_t handle = upload(source, length, true);
    if (!handle) return last_status;
    ir_state = a0_source_ir_init(token, handle, length, strict);
    last_status = ir_state.f0.e[0];
    ir_active = last_status == 0;
    return last_status;
}

uint32_t frontend_ir_upload(const uint32_t *words, uint32_t count) {
    if (!ir_active) { last_status = 5; return 0; }
    return upload(words, count, false);
}

uint32_t frontend_ir_symbol(uint32_t handle, uint32_t length) {
    if (!ir_active) return last_status = 5;
    IR_RESULT result = a0_source_ir_symbol(ir_state, handle, length);
    ir_state.f0 = result.f0;
    ir_state.f1 = result.f2;
    ir_value = result.f1;
    return last_status = result.f0.e[0];
}

uint32_t frontend_ir_type(uint32_t kind, uint32_t a, uint32_t b, uint32_t fields) {
    if (!ir_active) return last_status = 5;
    IR_RESULT result = a0_source_ir_type(ir_state, kind, a, b, fields);
    ir_state.f0 = result.f0;
    ir_state.f1 = result.f2;
    ir_value = result.f1;
    return last_status = result.f0.e[0];
}

uintptr_t frontend_ir_state(void) { return ir_active ? (uintptr_t)ir_state.f0.e : 0; }
uint32_t frontend_ir_value(void) { return ir_value; }

uint32_t frontend_ir_finish(void) {
    if (!ir_active) return last_status = 5;
    ir_active = false;
    state = a0_arena_verify_begin(ir_state.f1, ir_state.f0);
    while (state.f0.e[1] != 11) FRONTEND_RESUME(state, 97);
    return last_status = FRONTEND_STATUS(state.f0);
}

uintptr_t frontend_state(void) { return (uintptr_t)state.f1.e; }
uintptr_t frontend_specs(void) { return (uintptr_t)state.f2.e; }
uint32_t frontend_status(void) { return last_status; }

/* Read-only storage views scoped to this invocation. No source interpretation. */
uintptr_t frontend_view(uint32_t handle) {
    if (!session || !handle || handle > a0_arena_allocation_count(session)) return 0;
    return (uintptr_t)session->allocations[handle - 1].words;
}

uint32_t frontend_view_length(uint32_t handle) {
    if (!session || !handle || handle > a0_arena_allocation_count(session)) return 0;
    return session->allocations[handle - 1].length;
}

void frontend_close(void) {
    if (session) a0_arena_destroy(session);
    session = NULL;
    token = NULL;
    ir_active = false;
    ir_value = 0;
    last_status = 0;
    memset(&state, 0, sizeof state);
    memset(&ir_state, 0, sizeof ir_state);
}
