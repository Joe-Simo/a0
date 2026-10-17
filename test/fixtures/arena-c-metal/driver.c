#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "arena_runtime.h"
static a0_arena_session *session;
#define A0_COMPILER_READ(t) ((void)(t),a0_runtime_read(session))
#define A0_COMPILER_WRITE(t,v) ((void)(t),a0_runtime_write(session,(v)))
#include "module.c"
#include "api.h"
static bool word(FILE *f,uint32_t *out){unsigned char b[4];if(fread(b,1,4,f)!=4)return false;*out=(uint32_t)b[0]|(uint32_t)b[1]<<8|(uint32_t)b[2]<<16|(uint32_t)b[3]<<24;return true;}
static uint32_t reply(uint32_t *value){uint32_t s=a0_runtime_read(session),n=a0_runtime_read(session);for(uint32_t i=0;i<n;i++){uint32_t v=a0_runtime_read(session);if(value)*value=v;}return s;}
static uint32_t upload(uint32_t *data,uint32_t n,uint32_t *handle){
 if(!n){*handle=0;return 0;}
 a0_runtime_write(session,1);a0_runtime_write(session,1);a0_runtime_write(session,n);uint32_t s=reply(handle);if(s)return s;
 for(uint32_t off=0;off<n;){uint32_t count=n-off;if(count>128)count=128;a0_runtime_write(session,3);a0_runtime_write(session,count+3);a0_runtime_write(session,*handle);a0_runtime_write(session,off);a0_runtime_write(session,count);for(uint32_t i=0;i<count;i++)a0_runtime_write(session,data[off+i]);s=reply(NULL);if(s)return s;off+=count;}
 return 0;
}
static bool unchanged(uint32_t handle,const uint32_t *data,uint32_t n){
 for(uint32_t off=0;off<n;){uint32_t count=n-off;if(count>128)count=128;a0_runtime_write(session,2);a0_runtime_write(session,3);a0_runtime_write(session,handle);a0_runtime_write(session,off);a0_runtime_write(session,count);uint32_t s=a0_runtime_read(session),got=a0_runtime_read(session);if(s||got!=count)return false;for(uint32_t i=0;i<count;i++)if(a0_runtime_read(session)!=data[off+i])return false;off+=count;}
 return true;
}
static uint32_t load_context(const char *path,CTX_TYPE *ctx,uint32_t *data[6],uint32_t lengths[6],uint32_t handles[6]){
 FILE *f=fopen(path,"rb");if(!f)return 91;
 uint32_t status=0;memset(ctx,0,sizeof *ctx);
 for(uint32_t i=0;i<6;i++)if(!word(f,&lengths[i]))return 91;
 for(uint32_t i=11;i<14;i++)if(!word(f,&ctx->e[i]))return 91;
 for(uint32_t i=0;i<6;i++){
  if(lengths[i] && sizeof(uint32_t)>SIZE_MAX/lengths[i])return 91;
  data[i]=lengths[i]?malloc((size_t)lengths[i]*sizeof(uint32_t)):NULL;if(lengths[i]&&!data[i])return 91;
  for(uint32_t j=0;j<lengths[i];j++)if(!word(f,&data[i][j]))return 91;
  if(!status)status=upload(data[i],lengths[i],&handles[i]);ctx->e[i]=handles[i];
 }
 if(fgetc(f)!=EOF||fclose(f))return 91;
 return status;
}
int main(int argc,char **argv){
 if(argc<3)return 90;
 uint32_t budget=argc>3?(uint32_t)strtoul(argv[3],NULL,10):50000000u,maxout=argc>4?(uint32_t)strtoul(argv[4],NULL,10):50000000u;
 session=a0_arena_create(budget,maxout);if(!session)return 90;
 a0_io io,before;memset(&io,0xa5,sizeof io);memcpy(&before,&io,sizeof io);
 ARENA_HELLO_RESULT hello=a0_arena_hello(&io);uint32_t status=hello.f0;
 uint32_t lengths[6]={0},*data[6]={0},handles[6]={0};CTX_TYPE ctx;
 uint32_t target_lengths[6]={0},*target_data[6]={0},target_handles[6]={0};CTX_TYPE target;
 if(!status)status=load_context(argv[1],&ctx,data,lengths,handles);
 uint32_t mode=argc>5?(uint32_t)strtoul(argv[5],NULL,10):0,incap=argc>6?(uint32_t)strtoul(argv[6],NULL,10):256,outcap=argc>7?(uint32_t)strtoul(argv[7],NULL,10):1024,flags=argc>8?(uint32_t)strtoul(argv[8],NULL,10):0;
 if(mode>1)return 90;
 if(!status&&argc>9)status=load_context(argv[9],&target,target_data,target_lengths,target_handles);
 C_EMIT_RESULT result={0};if(!status){result=mode?(argc>9?a0_metal_emit_shaped(&io,ctx,target):a0_metal_emit(&io,ctx)):(argc>9?a0_c_emit_shaped(&io,ctx,target,incap,outcap,flags):a0_c_emit(&io,ctx,incap,outcap,flags));status=result.f0;}
 bool preserved=true;for(uint32_t i=0;i<6;i++){if(handles[i]&&!unchanged(handles[i],data[i],lengths[i]))preserved=false;if(target_handles[i]&&!unchanged(target_handles[i],target_data[i],target_lengths[i]))preserved=false;}
 if(!status){EW_EMIT_RESULT emitted=a0_ew_emit(&io,result.f1);status=emitted.f0;}
 ARENA_FINISH_RESULT finished=a0_arena_finish(&io,status);
 bool complete=a0_arena_is_complete(session),io_same=memcmp(&before,&io,sizeof io)==0;
 bool publish=!status&&!finished.f0&&complete&&a0_arena_finish_code(session)==0&&preserved&&io_same;
 uint32_t count=a0_arena_output_count(session);
 if(publish){FILE *out=fopen(argv[2],"wb");if(!out)return 92;const uint32_t *bytes=a0_arena_output(session);for(uint32_t i=0;i<count;i++){if(bytes[i]>255)return 93;if(fputc((int)bytes[i],out)==EOF)return 92;}if(fclose(out))return 92;}
 fprintf(stderr,"{\"status\":%u,\"complete\":%s,\"published\":%s,\"resultHandle\":%u,\"resultLength\":%u,\"outputCount\":%u,\"inputUnchanged\":%s,\"ioUnchanged\":%s,\"allocatedWords\":%u}\n",status,complete?"true":"false",publish?"true":"false",result.f1.f0,result.f1.f1,count,preserved?"true":"false",io_same?"true":"false",a0_arena_allocated_words(session));
 for(uint32_t i=0;i<6;i++){free(data[i]);free(target_data[i]);}a0_arena_destroy(session);
 return publish?0:(status?20:21);
}
