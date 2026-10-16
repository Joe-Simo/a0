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
static uint32_t response(uint32_t *value) {
 uint32_t status=a0_runtime_read(session),n=a0_runtime_read(session);
 for(uint32_t i=0;i<n;i++){uint32_t v=a0_runtime_read(session);if(value)*value=v;}
 return status;
}
static uint32_t upload(a0_io *io,const char *path,VECTOR_TYPE *vec) {
 FILE *f=fopen(path,"rb");if(!f)return 90;
 if(fseek(f,0,SEEK_END)){fclose(f);return 90;}long size=ftell(f);rewind(f);
 if(size<0||(uint64_t)size>UINT32_MAX){fclose(f);return 90;}
 BYTE_RESULT a=a0_av_new(io,(uint32_t)size);if(a.f0){fclose(f);return a.f0;}
 a.f1.f1=(uint32_t)size;*vec=a.f1;
 for(uint32_t off=0;off<(uint32_t)size;){
  uint32_t count=(uint32_t)size-off;if(count>128)count=128;
  a0_runtime_write(session,3);a0_runtime_write(session,count+3);
  a0_runtime_write(session,vec->f0);a0_runtime_write(session,off);a0_runtime_write(session,count);
  for(uint32_t j=0;j<count;j++){int c=fgetc(f);if(c==EOF){fclose(f);return 90;}a0_runtime_write(session,(uint32_t)c);}
  uint32_t status=response(NULL);if(status){fclose(f);return status;}off+=count;
 }
 fclose(f);return 0;
}
int main(int argc,char **argv){
 if(argc<6)return 90;
 uint32_t budget=argc>6?(uint32_t)strtoul(argv[6],NULL,10):10000000u;
 uint32_t maxout=argc>7?(uint32_t)strtoul(argv[7],NULL,10):5000000u;
 session=a0_arena_create(budget,maxout);if(!session)return 90;
 a0_io io;memset(&io,0xa5,sizeof io);a0_io before;memcpy(&before,&io,sizeof io);
 ARENA_HELLO_RESULT hello=a0_arena_hello(&io);uint32_t status=hello.f0;
 VECTOR_TYPE code={0,0,0};if(!status)status=upload(&io,argv[1],&code);
 ELF_BUILD_RESULT built={0};
 if(!status){built=a0_elf_build64(&io,code,(uint32_t)strtoul(argv[3],NULL,10),(uint32_t)strtoul(argv[4],NULL,10),(uint32_t)strtoul(argv[5],NULL,10),argc>8?(uint32_t)strtoul(argv[8],NULL,10):0);status=built.f0;}
 uint32_t result_handle=built.f1.f0,result_length=built.f1.f1;
 if(!status){EW_EMIT_RESULT emitted=a0_ew_emit(&io,built.f1);status=emitted.f0;}
 ARENA_FINISH_RESULT done=a0_arena_finish(&io,status);
 bool complete=a0_arena_is_complete(session);
 bool publish=!status&&!done.f0&&complete&&a0_arena_finish_code(session)==0;
 uint32_t count=a0_arena_output_count(session);
 if(publish){FILE *out=fopen(argv[2],"wb");if(!out)return 91;const uint32_t *bytes=a0_arena_output(session);for(uint32_t i=0;i<count;i++){if(bytes[i]>255)return 92;fputc((int)bytes[i],out);}if(fclose(out))return 91;}
 fprintf(stderr,"{\"status\":%u,\"finishStatus\":%u,\"complete\":%s,\"published\":%s,\"resultHandle\":%u,\"resultLength\":%u,\"outputCount\":%u,\"allocatedWords\":%u,\"ioUnchanged\":%s}\n",status,done.f0,complete?"true":"false",publish?"true":"false",result_handle,result_length,count,a0_arena_allocated_words(session),memcmp(&before,&io,sizeof io)?"false":"true");
 a0_arena_destroy(session);return status?20:(!publish?21:0);
}
