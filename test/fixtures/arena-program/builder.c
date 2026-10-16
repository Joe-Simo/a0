/* Native regression for the shared schema1 IR builder ABI.
 * api.h defines STATE (ab_begin return), MIO_RESULT (ab_node return),
 * OPERAND_RESULT (ab_operand return) from the actual emitted declarations.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "arena_runtime.h"
static a0_arena_session *session;
#define A0_COMPILER_READ(t) ((void)(t),a0_runtime_read(session))
#define A0_COMPILER_WRITE(t,v) ((void)(t),a0_runtime_write(session,(v)))
#include "module.c"
#include "api.h"
static void fail(const char *s) { fprintf(stderr,"%s\n",s); exit(1); }
static void want(uint32_t n) { if(a0_runtime_read(session)!=n) fail("protocol reply"); }
static void send(uint32_t op,uint32_t n,const uint32_t *a) {
  a0_runtime_write(session,op); a0_runtime_write(session,n);
  for(uint32_t i=0;i<n;i++) a0_runtime_write(session,a[i]);
}
static void row(const uint32_t *state,uint32_t offset,const uint32_t *expected,uint32_t n) {
  if(state[offset+1]<n) fail("short row vector");
  const uint32_t args[]={state[offset],0,n}; send(2,3,args); want(0); want(n);
  for(uint32_t i=0;i<n;i++) if(a0_runtime_read(session)!=expected[i]) fail("row field");
}
int main(void) {
  session=a0_arena_create(100000,0); if(!session) fail("session");
  want(0); want(2); want(A0_ARENA_MAGIC); want(A0_ARENA_VERSION);
  a0_io io,original_io; memset(&io,0xa5,sizeof io); memcpy(&original_io,&io,sizeof io);
  STATE p={{0}},original=p;
  p.e[93]=1; p.e[6]=66001; p.e[7]=70001; p.e[8]=1; original=p;
  STATE pending=a0_ab_begin(p,UINT32_C(4000000000),131073,64,90001,17001);
  if(memcmp(p.e,original.e,sizeof p.e)) fail("begin mutated caller state");
  MIO_RESULT s={pending,&io};
  OPERAND_RESULT o=a0_ab_operand(s,1,63,131073,70001,4);
  if(o.f1||o.f2!=&io) fail("operand result");
  const uint32_t operand[]={1,63,131073,70001,4}; row(o.f0.e,47,operand,5);
  STATE before_node=o.f0;
  MIO_RESULT os={o.f0,o.f2};
  MIO_RESULT n=a0_ab_node(os,UINT32_C(4000000001),37,0,1,
    UINT32_C(4000000002),UINT32_C(4000000003),17002,131073,64,196609,4,3,262145,70001);
  const uint32_t node[]={UINT32_C(4000000001),37,0,1,UINT32_C(4000000002),
    UINT32_C(4000000003),17002,131073,64,196609,4,3,262145,70001};
  row(n.f0.e,44,node,14); row(before_node.e,47,operand,5);
  if(before_node.e[44]||before_node.e[45]||before_node.e[46]) fail("node mutated caller descriptor");
  STATE returned=a0_ab_return(n.f0,0,17003);
  if(n.f0.e[19]!=UINT32_MAX||returned.e[10]||returned.e[22]) fail("return metadata/phase");
  MIO_RESULT rs={returned,&io};
  MIO_RESULT f=a0_ab_function(rs,17004,70001,UINT32_C(2147483648));
  const uint32_t function[]={UINT32_C(4000000000),131073,64,90001,0,1,0,
    17001,17003,17004,0,0,70001,UINT32_C(2147483648)};
  row(f.f0.e,41,function,14);
  STATE preserved=f.f0;
  MIO_RESULT second=a0_ab_node(f,UINT32_C(4000000005),37,0,1,
    UINT32_C(4000000002),UINT32_C(4000000003),17002,131073,64,196609,4,3,262145,70001);
  row(second.f0.e,44,node,14);
  if(memcmp(f.f0.e,preserved.e,sizeof preserved.e)) fail("later append mutated caller state");
  for(uint32_t code=2;code<=7;code++) {
    STATE bad={{0}}; bad.e[0]=code; bad.e[1]=714; bad.e[2]=17001;
    bad.e[3]=131073; bad.e[4]=70001; bad.e[5]=9; bad.e[14]=7;
    MIO_RESULT bs={bad,&io};
    MIO_RESULT bf=a0_ab_function(bs,99,7,3);
    if(memcmp(bf.f0.e,bad.e,sizeof bad.e)) fail("failed function publication");
    OPERAND_RESULT bo=a0_ab_operand(bs,2,UINT32_MAX,131073,70001,4);
    if(memcmp(bo.f0.e,bad.e,sizeof bad.e)||bo.f1) fail("failed operand publication");
    MIO_RESULT bn=a0_ab_node(bs,65537,2,0,2,UINT32_MAX,UINT32_MAX,99,131073,64,196609,3,1,0,0);
    if(memcmp(bn.f0.e,bad.e,6*sizeof(uint32_t))||bn.f0.e[44]||bn.f0.e[45]||bn.f0.e[46]||bn.f0.e[14]!=8)
      fail("first failure/partial node bookkeeping");
  }
  if(memcmp(&io,&original_io,sizeof io)) fail("IO token contents");
  const uint32_t code=0; send(5,1,&code); want(0); want(0);
  if(!a0_arena_is_complete(session)||a0_arena_finish_code(session)) fail("FINISH");
  a0_arena_destroy(session); puts("PASS shared IR construction seam"); return 0;
}
