#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "fs_runtime.h"
static a0fs_session *session;
#define A0_COMPILER_READ(t) ((void)(t),a0fs_read(session))
#define A0_COMPILER_WRITE(t,v) ((void)(t),a0fs_write(session,(v)))
#include "module.c"
#include "api.h"
static a0_io io,before;
static LINKED_RESULT linked;
static void die(const char*s){fprintf(stderr,"%s\n",s);exit(1);}
static void want(uint32_t n){uint32_t v=a0fs_read(session);if(v!=n){fprintf(stderr,"protocol %u/%u\n",v,n);exit(2);}}
static void send(uint32_t op,uint32_t n,const uint32_t*a){a0fs_write(session,op);a0fs_write(session,n);for(uint32_t i=0;i<n;i++)a0fs_write(session,a[i]);}
static void load(uint32_t h,uint32_t off,uint32_t n,uint32_t*page){uint32_t a[]={h,off,n};send(2,3,a);want(0);want(n);for(uint32_t i=0;i<n;i++)page[i]=a0fs_read(session);}
static uint32_t upload(const unsigned char*s,uint32_t n){if(!n)return 0;send(1,1,&n);want(0);want(1);uint32_t h=a0fs_read(session);for(uint32_t i=0;i<n;){uint32_t k=n-i>128?128:n-i,a[131]={h,i,k};for(uint32_t j=0;j<k;j++)a[j+3]=s[i+j];send(3,k+3,a);want(0);want(0);i+=k;}return h;}
static void out(FILE*f,uint32_t n){if(fwrite(&n,4,1,f)!=1)die("output");}
static void raw(FILE*f,const uint32_t*p,uint32_t n){for(uint32_t i=0;i<n;i++)out(f,p[i]);}
static void bytes(FILE*f,uint32_t h,uint32_t start,uint32_t len){out(f,len);for(uint32_t i=0;i<len;){uint32_t n=len-i>128?128:len-i,page[128];load(h,start+i,n,page);raw(f,page,n);i+=n;}}
static void vector(FILE*f,const uint32_t*p,uint32_t off){bytes(f,p[off],0,p[off+1]);}
int main(int argc,char**argv){if(argc!=7)die("entry root override quantum budget output");session=a0fs_create((uint32_t)strtoul(argv[5],NULL,10),0);if(!session)die("session");memset(&io,0xa5,sizeof io);memcpy(&before,&io,sizeof io);HELLO_RESULT hello=a0_fs_hello(&io);if(hello.f0||hello.f1!=&io)die("hello");uint32_t en=(uint32_t)strlen(argv[1]),rn=(uint32_t)strlen(argv[2]),eh=upload((const unsigned char*)argv[1],en),rh=upload((const unsigned char*)argv[2],rn);linked=a0_arena_link_verify_begin(&io,eh,en,rh,rn,true,(uint32_t)strtoul(argv[3],NULL,10),false,100000);uint32_t quantum=(uint32_t)strtoul(argv[4],NULL,10),pumps=0;if(!a0_arena_link_verify_done(linked.f0)){LINKED_RESULT zero=a0_arena_link_verify_resume(linked,0);if(memcmp(&zero,&linked,sizeof zero))die("zero quantum changed continuation");if(a0_arena_link_verify_status(linked.f0)!=7||linked.f0.e[0])die("pending seven");}while(!a0_arena_link_verify_done(linked.f0)){if(pumps++==2000000)die("proof pump bound");linked=a0_arena_link_verify_resume(linked,quantum);}LINKED_RESULT terminal=a0_arena_link_verify_resume(linked,quantum);if(memcmp(&terminal,&linked,sizeof terminal))die("terminal changed");if(linked.f1.f6!=&io)die("returned IO");if(a0_arena_link_verify_status(linked.f0)!=linked.f0.e[0])die("final status");FILE*f=fopen(argv[6],"wb");if(!f)die("output open");out(f,pumps);raw(f,linked.f0.e,128);raw(f,linked.f1.f0.e,128);raw(f,linked.f1.f1.e,128);raw(f,linked.f1.f2.e,128);raw(f,linked.f1.f3.e,128);raw(f,linked.f1.f4.e,128);raw(f,linked.f1.f5.e,128);raw(f,linked.f2.e,128);const uint32_t lo[]={32,35,38,41,44,50,53,56,59,62,68,74,77,100,103,106,109};for(uint32_t i=0;i<sizeof lo/sizeof lo[0];i++)vector(f,linked.f2.e,lo[i]);const uint32_t mo[]={32,35,38,41,44,47,50,53,56,59,62,68,71,74,97,100,103,106};for(uint32_t i=0;i<sizeof mo/sizeof mo[0];i++)vector(f,linked.f1.f1.e,mo[i]);uint32_t files=linked.f2.e[33]/12;out(f,files);for(uint32_t i=0;i<files;i++){uint32_t row[128];load(linked.f2.e[32],i*12,12,row);raw(f,row,12);bytes(f,row[0],0,row[1]);bytes(f,row[2],0,row[3]);}uint32_t symbols=linked.f1.f1.e[67];out(f,symbols);for(uint32_t i=0;i<symbols;i++){uint32_t row[128];load(linked.f1.f1.e[62],i*5,5,row);bytes(f,row[0],row[1],row[2]);}vector(f,linked.f0.e,32);bytes(f,linked.f0.e[20],0,linked.f0.e[21]);uint64_t calls=a0fs_calls(session,17);out(f,(uint32_t)calls);out(f,(uint32_t)(calls>>32));fclose(f);if(memcmp(&io,&before,sizeof io))die("IO bytes changed");uint32_t code=0;send(5,1,&code);want(0);want(0);if(!a0fs_is_complete(session)||a0fs_allocated_words(session)||a0fs_protocol_failed(session))die("incomplete transport");a0fs_destroy(session);return 0;}
