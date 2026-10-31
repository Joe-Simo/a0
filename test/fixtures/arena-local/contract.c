#include "arena_runtime.h"
#include <assert.h>
#ifdef _WIN32
#include <windows.h>
#else
#include <pthread.h>
#endif
#include <stdio.h>
#include <string.h>
#include <limits.h>
static unsigned checks;
#define CHECK(x) do { assert(x); checks++; } while (0)
static void hello(a0_arena_session *s) {
  assert(a0_runtime_read(s)==0);assert(a0_runtime_read(s)==2);
  assert(a0_runtime_read(s)==A0_ARENA_MAGIC);assert(a0_runtime_read(s)==1);
}
static uint32_t request(a0_arena_session *s,uint32_t op,const uint32_t *a,uint32_t n,uint32_t *out) {
  a0_runtime_write(s,op);a0_runtime_write(s,n);
  for(uint32_t i=0;i<n;i++)a0_runtime_write(s,a[i]);
  uint32_t status=a0_runtime_read(s), count=a0_runtime_read(s);
  assert(count<=128);for(uint32_t i=0;i<count;i++)out[i]=a0_runtime_read(s);
  return status;
}
static uint32_t alloc_wire(a0_arena_session *s,uint32_t count,uint32_t *handle) {
  uint32_t page[128]={0};uint32_t code=request(s,1,&count,1,page);*handle=page[0];return code;
}
static uint32_t load_wire(a0_arena_session *s,uint32_t h,uint32_t off,uint32_t count,uint32_t *out) {
  uint32_t a[]={h,off,count};memset(out,0,128*sizeof *out);return request(s,2,a,3,out);
}
static uint32_t store_wire(a0_arena_session *s,uint32_t h,uint32_t off,uint32_t count,const uint32_t *words) {
  if(count>128)return A0_ARENA_RANGE; /* Source arena_store precondition. */
  uint32_t a[131]={h,off,count},out[128]={0};memcpy(a+3,words,count*sizeof *words);return request(s,3,a,count+3,out);
}
static uint32_t random_word(uint32_t *x){*x^=*x<<13;*x^=*x>>17;*x^=*x<<5;return *x;}
static void paired(void) {
  a0_arena_session *wire=a0_arena_create(511,0),*direct=a0_arena_create(511,0);assert(wire&&direct);
  CHECK(a0_arena_local_open(direct)==NULL);hello(wire);hello(direct);
  a0_arena_local *local=a0_arena_local_open(direct);CHECK(local!=NULL);CHECK(a0_arena_local_open(direct)==NULL);
  uint32_t seed=0x1347abcd,payload[128],a[128],b[128],ha,hb;
  const uint32_t counts[]={0,1,2,127,128,129,UINT32_MAX,32};
  for(unsigned i=0;i<sizeof counts/sizeof *counts;i++){
    uint32_t ca=alloc_wire(wire,counts[i],&ha),cb=a0_arena_local_alloc(local,counts[i],&hb);CHECK(ca==cb);CHECK(ha==hb);
  }
  for(unsigned i=0;i<4000;i++){
    uint32_t h=random_word(&seed)%12,off=random_word(&seed)%140,n=random_word(&seed)%132;
    if(i%19==0)off=UINT32_MAX;if(i%23==0)h=UINT32_MAX;
    for(unsigned j=0;j<128;j++)payload[j]=random_word(&seed);
    if(i%3==0){CHECK(store_wire(wire,h,off,n,payload)==a0_arena_local_store(local,h,off,n,payload));}
    else {CHECK(load_wire(wire,h,off,n,a)==a0_arena_local_load(local,h,off,n,b));CHECK(memcmp(a,b,sizeof a)==0);}
    CHECK(a0_arena_allocated_words(wire)==a0_arena_allocated_words(direct));CHECK(a0_arena_allocation_count(wire)==a0_arena_allocation_count(direct));
  }
  for(uint32_t h=1;h<=a0_arena_allocation_count(wire);h++)for(uint32_t off=0;off<130;off++){
    CHECK(load_wire(wire,h,off,1,a)==a0_arena_local_load(local,h,off,1,b));CHECK(memcmp(a,b,sizeof a)==0);
  }
  uint32_t z=0;CHECK(request(wire,5,&z,1,a)==request(direct,5,&z,1,b));
  CHECK(a0_arena_local_alloc(local,1,&ha)==A0_ARENA_FINISHED);CHECK(ha==0);
  CHECK(a0_arena_local_load(local,0,0,129,b)==A0_ARENA_FINISHED);
  CHECK(a0_arena_local_store(local,0,0,129,b)==A0_ARENA_RANGE);
  CHECK(a0_arena_is_complete(wire)&&a0_arena_is_complete(direct));
  a0_arena_reset(direct);CHECK(a0_arena_local_alloc(local,1,&ha)==A0_ARENA_PROTOCOL);hello(direct);
  a0_arena_local *fresh=a0_arena_local_open(direct);CHECK(fresh!=NULL);
  CHECK(a0_arena_local_alloc(fresh,1,&ha)==0&&ha==1);
  CHECK(a0_arena_local_alloc(local,1,&hb)==1&&hb==0); /* Old capability cannot alias reused handle. */
  a0_arena_local_close(local);a0_arena_destroy(direct);
  CHECK(a0_arena_local_load(fresh,1,0,1,b)==A0_ARENA_PROTOCOL);a0_arena_local_close(fresh);a0_arena_destroy(wire);
}
static void edges(void) {
  a0_arena_session *s=a0_arena_create(128,0);assert(s);hello(s);a0_arena_local *c=a0_arena_local_open(s);assert(c);
  uint32_t h=0,out[128],in[128];for(unsigned i=0;i<128;i++)in[i]=i^0xdeadbeef;
  CHECK(a0_arena_local_alloc(c,128,&h)==0&&h==1);
  CHECK(a0_arena_local_store(c,h,0,128,in)==0);CHECK(load_wire(s,h,0,128,out)==0&&memcmp(in,out,sizeof in)==0);
  in[0]=7;CHECK(store_wire(s,h,0,1,in)==0);CHECK(a0_arena_local_load(c,h,0,1,out)==0&&out[0]==7);CHECK(out[1]==0);
  CHECK(a0_arena_local_load(c,h,128,0,out)==0);CHECK(a0_arena_local_store(c,h,128,0,in)==0);
  CHECK(a0_arena_local_load(c,0,UINT32_MAX,129,out)==3); /* Count before handle/range. */
  CHECK(a0_arena_local_load(c,0,UINT32_MAX,1,out)==2); /* Handle before range. */
  a0_runtime_write(s,2);CHECK(a0_arena_local_load(c,h,0,1,out)==1); /* No bypass of pending wire frame. */
  a0_runtime_write(s,3);a0_runtime_write(s,h);a0_runtime_write(s,0);a0_runtime_write(s,1);
  CHECK(a0_runtime_read(s)==0);CHECK(a0_runtime_read(s)==1);CHECK(a0_runtime_read(s)==7);
  CHECK(a0_arena_local_load(c,h,0,1,out)==0);a0_arena_local_close(c);a0_arena_destroy(s);
}
static void *thread(void *unused) {
  (void)unused;
  for(unsigned k=0;k<100;k++){
    a0_arena_session *s=a0_arena_create(4,0);assert(s);hello(s);a0_arena_local *c=a0_arena_local_open(s);assert(c);
    uint32_t h,in[128]={k},out[128];assert(a0_arena_local_alloc(c,4,&h)==0);assert(a0_arena_local_store(c,h,0,1,in)==0);assert(a0_arena_local_load(c,h,0,1,out)==0&&out[0]==k);
    a0_arena_destroy(s);assert(a0_arena_local_load(c,h,0,1,out)==1);a0_arena_local_close(c);
  }
  return NULL;
}
#ifdef _WIN32
static DWORD WINAPI windows_thread(LPVOID p) { thread(p); return 0; }
#endif
int main(void) {
  paired(); edges();
#ifdef _WIN32
  HANDLE threads[4];
  for(unsigned i=0;i<4;i++) { threads[i]=CreateThread(NULL,0,windows_thread,NULL,0,NULL); assert(threads[i]); }
  assert(WaitForMultipleObjects(4,threads,TRUE,INFINITE)==WAIT_OBJECT_0);
  for(unsigned i=0;i<4;i++) assert(CloseHandle(threads[i]));
#else
  pthread_t threads[4];
  for(unsigned i=0;i<4;i++) assert(pthread_create(&threads[i],NULL,thread,NULL)==0);
  for(unsigned i=0;i<4;i++) assert(pthread_join(threads[i],NULL)==0);
#endif
  printf("local arena contract: %u checks;400 concurrent independent lifetimes passed\n",checks);
}
