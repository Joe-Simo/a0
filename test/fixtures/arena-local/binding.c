#include "arena_runtime.h"
#include <assert.h>
#include <stdio.h>
struct a0_io { unsigned unused; };
static struct a0_io owner_token, foreign_token;
static a0_arena_session *session;
static a0_arena_local *capability;
#define A0_LOCAL_ARENA(t) ((t) == &owner_token ? capability : NULL)
#define A0_IO_READ(t,out) ((void)(t), *(out)=a0_runtime_read(session), true)
#define A0_IO_WRITE(t,v) ((void)(t), a0_runtime_write(session,(v)))
#include "module.c"
int main(void) {
  session=a0_arena_create(8,0);assert(session);
  assert(a0_runtime_read(session)==0);assert(a0_runtime_read(session)==2);
  assert(a0_runtime_read(session)==A0_ARENA_MAGIC);assert(a0_runtime_read(session)==1);
  capability=a0_arena_local_open(session);assert(capability);
  a0t_r3_u_u_io a=a0_arena_alloc(&owner_token,8);assert(a.f0==0&&a.f1==1&&a.f2==&owner_token);
  a0t_r3_u_u_io bad=a0_arena_alloc(&foreign_token,1);assert(bad.f0==1&&bad.f1==0&&bad.f2==&foreign_token);
  a0t_r3_u_a128_u_io load=a0_arena_load(&foreign_token,1,0,1);assert(load.f0==1&&load.f2==&foreign_token);
  for(unsigned i=0;i<128;i++)assert(load.f1.e[i]==0);
  a0t_a128_u page={{9}};a0t_r2_u_io store=a0_arena_store(&foreign_token,1,0,1,page);assert(store.f0==1&&store.f1==&foreign_token);
  load=a0_arena_load(&owner_token,1,0,1);assert(load.f0==0&&load.f1.e[0]==0);
  store=a0_arena_store(&owner_token,1,0,1,page);assert(store.f0==0);
  load=a0_arena_load(&owner_token,1,0,1);assert(load.f0==0&&load.f1.e[0]==9);
  a0_arena_local_close(capability);capability=NULL;
  bad=a0_arena_alloc(&owner_token,1);assert(bad.f0==1&&bad.f1==0);
  a0_arena_destroy(session);puts("local binding: foreign and closed tokens refused");
}
