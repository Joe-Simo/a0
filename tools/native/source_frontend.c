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
static uint32_t last_status;

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

uint32_t frontend_abi(void) { return 2; }

static uint32_t parse_source(const uint8_t *source, uint32_t length, uint32_t budget, bool unit) {
    if (session) a0_arena_destroy(session);
    memset(&state, 0, sizeof state);
    memset(&frontend_io, 0, sizeof frontend_io);
    token = &frontend_io;
    session = a0_arena_create(budget, 0);
    if (!session) return last_status = 4;
    uint32_t status = reply(2);
    if (status) return last_status = status;
    (void)a0_runtime_read(session);
    (void)a0_runtime_read(session);
    uint32_t n = length ? length : 1;
    send(1, 1, &n);
    status = reply(1);
    if (status) return last_status = status;
    uint32_t handle = a0_runtime_read(session);
    for (uint32_t i = 0; i < length;) {
        uint32_t count = length - i > 128 ? 128 : length - i;
        uint32_t words[131] = { handle, i, count };
        for (uint32_t j = 0; j < count; j++) words[j + 3] = source[i + j];
        send(3, count + 3, words);
        status = reply(0);
        if (status) return last_status = status;
        i += count;
    }
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
    memset(&state, 0, sizeof state);
}
