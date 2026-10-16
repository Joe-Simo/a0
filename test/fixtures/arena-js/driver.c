/* Generic source-byte and opaque continuation transport. All parsing, checking,
 * verification, structural lowering and JavaScript decisions execute in A0. */
#include <stdint.h>
#include <stdio.h>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif
#include <stdlib.h>
#include <string.h>
#include "arena_runtime.h"
static a0_arena_session *session;
#define A0_COMPILER_READ(t) ((void)(t),a0_runtime_read(session))
#define A0_COMPILER_WRITE(t,v) ((void)(t),a0_runtime_write(session,(v)))
#include "module.c"
#include "api.h"
static void die(const char*s){fprintf(stderr,"%s\n",s);exit(2);}
static uint32_t word(void){unsigned char b[4];if(fread(b,1,4,stdin)!=4)die("truncated input");return (uint32_t)b[0]|(uint32_t)b[1]<<8|(uint32_t)b[2]<<16|(uint32_t)b[3]<<24;}
static void out(uint32_t v){unsigned char b[4]={(unsigned char)v,(unsigned char)(v>>8),(unsigned char)(v>>16),(unsigned char)(v>>24)};if(fwrite(b,1,4,stdout)!=4)die("write output");}
static void want(uint32_t v){if(a0_runtime_read(session)!=v)die("storage reply");}
static void send(uint32_t op,uint32_t n,const uint32_t*a){a0_runtime_write(session,op);a0_runtime_write(session,n);for(uint32_t i=0;i<n;i++)a0_runtime_write(session,a[i]);}
struct immutable_slice { uint32_t handle, length, *data; };
static struct immutable_slice snapshots[13];
static unsigned snapshot_count;
static void keep(uint32_t handle,uint32_t length){
 if(!length)return;
 if(snapshot_count>=13)die("metadata snapshot directory");
 struct immutable_slice *s=&snapshots[snapshot_count++];
 s->handle=handle;s->length=length;s->data=malloc((size_t)length*sizeof(uint32_t));
 if(!s->data)die("metadata snapshot allocation");
 for(uint32_t off=0;off<length;){uint32_t n=length-off>128?128:length-off,a[3]={handle,off,n};send(2,3,a);want(0);want(n);for(uint32_t j=0;j<n;j++)s->data[off+j]=a0_runtime_read(session);off+=n;}
}
static void unchanged(void){
 for(unsigned i=0;i<snapshot_count;i++){
  struct immutable_slice *s=&snapshots[i];
  for(uint32_t off=0;off<s->length;){uint32_t n=s->length-off>128?128:s->length-off,a[3]={s->handle,off,n};send(2,3,a);want(0);want(n);for(uint32_t j=0;j<n;j++)if(a0_runtime_read(session)!=s->data[off+j])die("original descriptor metadata changed");off+=n;}
  free(s->data);
 }
}
int main(void){
#ifdef _WIN32
 _setmode(_fileno(stdin),_O_BINARY);
 _setmode(_fileno(stdout),_O_BINARY);
#endif
 if(word()!=0x414a5350u)die("packet magic");
 uint32_t max=word(),maxout=word(),quantum=word(),length=word(),observation=word();
 if(!quantum&&!observation)die("zero scheduling quantum");
 session=a0_arena_create(max,maxout);if(!session)die("session allocation");
 want(0);want(2);want(A0_ARENA_MAGIC);want(1);
 uint32_t n=length?length:1;send(1,1,&n);want(0);want(1);
 uint32_t source=a0_runtime_read(session);
 uint32_t *original=malloc((size_t)n*sizeof(uint32_t));if(!original)die("inspection allocation");
 for(uint32_t i=0;i<length;){uint32_t k=length-i>128?128:length-i,a[131]={source,i,k};for(uint32_t z=0;z<k;z++){a[z+3]=word();original[i+z]=a[z+3];}send(3,k+3,a);want(0);want(0);i+=k;}
 a0_io io,before;memset(&io,0xa5,sizeof io);memcpy(&before,&io,sizeof io);
 JS_STATE s=a0_arena_js_begin(&io,source,length);
 uint64_t count=0;
 uint32_t originalctx[16],originald[128];int retained=0;
 while(s.f0.e[0]==0&&s.f0.e[1]!=3){if(observation&&count>=observation)break;if(!retained&&s.f0.e[1]==2){
  if(s.f3.e[0]!=0||s.f3.e[1]!=0x41304243u||s.f3.e[2]!=1)die("original A0BC descriptor");
  memcpy(originalctx,s.f2.e,sizeof originalctx);memcpy(originald,s.f3.e,sizeof originald);
  keep(s.f3.e[4],128);if(s.f3.e[5])keep(s.f3.e[5],128);
  for(unsigned v=16;v<=46;v+=3)keep(s.f3.e[v],s.f3.e[v+1]);
  retained=1;
 }
 s=a0_arena_js_resume(s,quantum);if(++count>10000000)die("test continuation watchdog");}
 if(retained){if(memcmp(originalctx,s.f2.e,sizeof originalctx)||memcmp(originald,s.f3.e,sizeof originald))die("original ctx or D changed");unchanged();}
 for(uint32_t at=0;at<length;){uint32_t k=length-at>128?128:length-at,a[3]={source,at,k};send(2,3,a);want(0);want(k);for(uint32_t j=0;j<k;j++)if(a0_runtime_read(session)!=original[at+j])die("source bytes changed");at+=k;}
 free(original);
 JS_RESULT r=a0_arena_js_result(s);uint32_t code=r.f0;
 if(r.f2!=&io||memcmp(&io,&before,sizeof io))die("transport IO changed");
 if(code==0){EW_RESULT emitted=a0_ew_emit(r.f2,r.f1);code=emitted.f0;if(emitted.f1!=&io)die("emission IO changed");}
 else if(r.f1.f0||r.f1.f1||r.f1.f2)die("partial public output on failure");
 if(memcmp(&io,&before,sizeof io)||a0_arena_protocol_failed(session))die("transport protocol failure");
 send(5,1,&code);want(0);want(0);
 if(!a0_arena_is_complete(session)||a0_arena_allocated_words(session)||a0_arena_finish_code(session)!=code)die("incomplete FINISH");
 out(0x414a5350u);out(code);out((uint32_t)count);out((uint32_t)(count>>32));
 for(uint32_t i=0;i<128;i++)out(s.f0.e[i]);
 for(uint32_t i=0;i<128;i++)out(s.f1.f0.e[i]);
 for(uint32_t i=0;i<6;i++)out(s.f1.f1.e[i]);
 uint32_t len=code==0?a0_arena_output_count(session):0;out(len);
 const uint32_t *bytes=a0_arena_output(session);for(uint32_t i=0;i<len;i++){if(bytes[i]>255)die("nonbyte output");out(bytes[i]);}
 a0_arena_destroy(session);return 0;
}
