/* Binary transport and generic arena storage only; A0 owns every compiler stage. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif
#include "arena_runtime.h"
static a0_arena_session *session;
static uint32_t phase,op,nargs,at,enabled,fault_op,fault_nth,fault_status,seen;
static uint32_t injected[2],injected_at=2;
static void die(const char*s){fprintf(stderr,"%s\n",s);exit(2);}
static uint32_t tr_read(void){if(injected_at<2)return injected[injected_at++];return a0_runtime_read(session);}
static void tr_write(uint32_t v){
 int done=0;if(!phase){op=v;phase=1;}else if(phase==1){nargs=v;at=0;phase=v?2:0;done=!v;}else{at++;if(at==nargs){phase=0;done=1;}}
 a0_runtime_write(session,v);
 if(done&&enabled&&op==fault_op&&++seen==fault_nth){(void)a0_runtime_read(session);uint32_t n=a0_runtime_read(session);for(uint32_t i=0;i<n;i++)(void)a0_runtime_read(session);injected[0]=fault_status;injected[1]=0;injected_at=0;}
}
#define A0_COMPILER_READ(t) ((void)(t),tr_read())
#define A0_COMPILER_WRITE(t,v) ((void)(t),tr_write(v))
#include "module.c"
#include "api.h"
static uint32_t word(void){unsigned char b[4];if(fread(b,1,4,stdin)!=4)die("truncated input");return (uint32_t)b[0]|(uint32_t)b[1]<<8|(uint32_t)b[2]<<16|(uint32_t)b[3]<<24;}
static void out(uint32_t v){unsigned char b[4]={(unsigned char)v,(unsigned char)(v>>8),(unsigned char)(v>>16),(unsigned char)(v>>24)};if(fwrite(b,1,4,stdout)!=4)die("output");}
static void want(uint32_t v){if(tr_read()!=v)die("storage reply");}
static void send(uint32_t opcode,uint32_t n,const uint32_t *a){tr_write(opcode);tr_write(n);for(uint32_t i=0;i<n;i++)tr_write(a[i]);}
static uint32_t upload(uint32_t n){uint32_t h=0;if(!n)return 0;send(1,1,&n);want(0);want(1);h=tr_read();for(uint32_t i=0;i<n;){uint32_t count=n-i>128?128:n-i,a[131]={h,i,count};for(uint32_t j=0;j<count;j++)a[j+3]=word();send(3,count+3,a);want(0);want(0);i+=count;}return h;}
static uint32_t mode,length,quantum,source,options,selector,type_id,code,e[128],verify[128],checked[128],descriptor[128],context_words[16];
static CS_CTX ctx;
static a0_io io,before;
static uint64_t resumes;
static void *worker(void *unused){
 (void)unused;memset(&io,0xa5,sizeof io);memcpy(&before,&io,sizeof io);enabled=1;
 if(mode==0){
  CS_STATE s=a0_arena_csharp_source_begin(&io,source,length);
  while(!a0_arena_csharp_source_done(s.f0)){s=a0_arena_csharp_source_resume(s,quantum);resumes++;}
  code=a0_arena_csharp_source_status(s.f0);
  memcpy(e,s.f0.e,sizeof e);memcpy(verify,s.f1.f3.f0.e,sizeof verify);memcpy(checked,s.f1.f3.f1.e,sizeof checked);memcpy(descriptor,s.f1.f2.e,sizeof descriptor);memcpy(context_words,s.f1.f1.e,sizeof context_words);
  if(s.f1.f3.f6!=&io)die("token identity");
  CS_STATUSIO published=a0_arena_csharp_source_publish(s);code=published.f0;if(published.f1!=&io)die("token identity");
 }else{
  CS_WRITER r;
  if(selector==1){CS_WRITER start={0,{0,0,0},&io};r=a0_acs_mangle(start,ctx,type_id);}
  else if(selector==2){CS_WRITER start={0,{0,0,0},&io};r=a0_acs_type(start,ctx,type_id);}
  else r=a0_acs_emit_options(&io,ctx,options);
  code=r.f0;if(r.f2!=&io)die("token identity");if(!code){CS_STATUSIO p=a0_ew_emit(&io,r.f1);code=p.f0;}
  memcpy(context_words,ctx.e,sizeof context_words);
 }
 enabled=0;if(memcmp(&io,&before,sizeof io))die("buffered IO changed");return NULL;
}
int main(void){
#ifdef _WIN32
 _setmode(_fileno(stdin),_O_BINARY);_setmode(_fileno(stdout),_O_BINARY);
#endif
 if(word()!=0x41435346u)die("packet magic");mode=word();uint32_t max=word(),maxout=word();quantum=word();length=word();fault_op=word();fault_nth=word();fault_status=word();if(mode>1||!quantum)die("protocol mode/quantum");
 session=a0_arena_create(max,maxout);if(!session)die("session allocation");want(0);want(2);want(A0_ARENA_MAGIC);want(1);
 if(!mode)source=upload(length);else{for(uint32_t i=0;i<6;i++)ctx.e[i]=upload(word());ctx.e[11]=word();ctx.e[12]=word();ctx.e[13]=word();options=word();selector=word();type_id=word();}
 if(fgetc(stdin)!=EOF)die("trailing input");pthread_attr_t attr;pthread_t thread;if(pthread_attr_init(&attr)||pthread_attr_setstacksize(&attr,(size_t)1u<<30))die("thread attributes");if(pthread_create(&thread,&attr,worker,NULL))die("thread start");pthread_attr_destroy(&attr);if(pthread_join(thread,NULL))die("thread join");
 if(a0_arena_protocol_failed(session))die("protocol failure");uint32_t count=code?0:a0_arena_output_count(session);const uint32_t *bytes=a0_arena_output(session);for(uint32_t i=0;i<count;i++)if(bytes[i]>255)die("nonbyte output");
 send(5,1,&code);want(0);want(0);if(!a0_arena_is_complete(session)||a0_arena_finish_code(session)!=code||a0_arena_allocated_words(session))die("incomplete FINISH");
 out(0x41435346u);out(code);out((uint32_t)resumes);out((uint32_t)(resumes>>32));for(uint32_t i=0;i<128;i++)out(e[i]);for(uint32_t i=0;i<128;i++)out(verify[i]);for(uint32_t i=0;i<128;i++)out(checked[i]);for(uint32_t i=0;i<128;i++)out(descriptor[i]);for(uint32_t i=0;i<16;i++)out(context_words[i]);out(count);for(uint32_t i=0;i<count;i++)out(bytes[i]);
 a0_arena_destroy(session);return 0;
}
