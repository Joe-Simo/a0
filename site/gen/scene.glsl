#version 300 es
precision mediump float;
uniform vec2 u_res;uniform float u_time;uniform vec2 u_mouse;uniform float u_dark;
out vec4 o;
float h(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float glyph(vec2 g,float seed){vec2 c=floor(g*vec2(3.,5.));float b=step(.5,h(c+seed));vec2 f=fract(g*vec2(3.,5.));return b*step(.15,f.x)*step(.15,f.y)*step(f.x,.85)*step(f.y,.85);}
void main(){
vec2 px=gl_FragCoord.xy;float cell=16.;
vec2 id=floor(px/cell);vec2 g=fract(px/cell);
float col=id.x;float speed=4.+8.*h(vec2(col,1.));float len=8.+18.*h(vec2(col,2.));
float rows=u_res.y/cell;float head=mod(u_time*speed+h(vec2(col,3.))*rows*3.,rows+len*2.);
float y=rows-id.y;float d=head-y;
float trail=d>=0.&&d<len?1.-d/len:0.;
float flick=floor(u_time*(6.+10.*h(id)));
float gl=glyph(g,floor(h(id+flick)*97.));
float hd=d>=0.&&d<1.?1.:0.;
vec3 green=mix(vec3(0.,.35,.12),vec3(0.,.95,.35),trail);
vec3 c=green*gl*trail*.55+vec3(.75,1.,.8)*gl*hd*.8;
float fade=smoothstep(0.,.35,px.y/u_res.y);
vec3 bg=mix(vec3(.93,.97,.93),vec3(0.),u_dark);
vec3 ink=mix(vec3(0.,.35,.12)*.9,c,u_dark);
float a=mix(.22,1.,u_dark)*fade;
o=vec4(mix(bg,bg+ink*(u_dark>.5?1.:-1.)*1.,a*(gl*max(trail,hd))),1.);
}
