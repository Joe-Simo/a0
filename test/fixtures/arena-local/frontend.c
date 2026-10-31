#include <stdio.h>
#include <stdlib.h>
#include "driver.c"
static void word(uint32_t value) {
  unsigned char b[4]={(unsigned char)value,(unsigned char)(value>>8),(unsigned char)(value>>16),(unsigned char)(value>>24)};
  if(fwrite(b,1,4,stdout)!=4)exit(4);
}
int main(int argc,char **argv){
  if(argc<2)return 2;
  FILE *f=fopen(argv[1],"rb");if(!f)return 2;
  if(fseek(f,0,SEEK_END))return 2;long n=ftell(f);if(n<0||(unsigned long)n>UINT32_MAX)return 2;rewind(f);
  unsigned char *source=malloc((size_t)n+1);if(!source)return 2;
  if(fread(source,1,(size_t)n,f)!=(size_t)n)return 2;fclose(f);
  uint32_t budget=argc>2?(uint32_t)strtoul(argv[2],NULL,10):16000000;
  word(frontend_parse(source,(uint32_t)n,budget));
  for(unsigned i=0;i<128;i++)word(state.f0.e[i]);
  for(unsigned i=0;i<128;i++)word(state.f1.e[i]);
  for(unsigned i=0;i<128;i++)word(state.f2.e[i]);
  for(unsigned i=0;i<128;i++)word(state.f3.e[i]);
  for(unsigned i=0;i<128;i++)word(state.f4.e[i]);
  for(unsigned i=0;i<128;i++)word(state.f5.e[i]);
  word(a0_arena_protocol_failed(session));word(a0_arena_allocated_words(session));word(a0_arena_allocation_count(session));
  for(uint32_t h=1;h<=a0_arena_allocation_count(session);h++){
    uint32_t size=frontend_view_length(h);word(size);const uint32_t *data=(const uint32_t *)frontend_view(h);
    for(uint32_t i=0;i<size;i++)word(data[i]);
  }
#ifdef A0_TRACE_ARENA
  fprintf(stderr,"{\"reads\":%llu,\"writes\":%llu}\n",(unsigned long long)a0_trace_reads,(unsigned long long)a0_trace_writes);
#endif
  frontend_close();free(source);return 0;
}
