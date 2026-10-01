#version 300 es
precision mediump float;
uniform vec2 u_res;uniform float u_time;uniform sampler2D u_font;
out vec4 o;
float h(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
void main(){
float cell=clamp(u_res.x/84.,12.,18.);
vec2 px=vec2(gl_FragCoord.x,u_res.y-gl_FragCoord.y);
vec2 id=floor(px/cell);vec2 g=fract(px/cell);
float col=id.x;
if(h(vec2(col,5.))<.3){o=vec4(0.,0.,0.,1.);return;}
float rows=ceil(u_res.y/cell);
float speed=5.+9.*h(vec2(col,1.));
float len=6.+22.*h(vec2(col,2.));
float period=rows+len+rows*1.5*h(vec2(col,4.));
float head=mod(u_time*speed+h(vec2(col,3.))*period,period);
float d=head-id.y;
if(d<0.||d>len){o=vec4(0.,0.,0.,1.);return;}
float flick=step(.75,h(id+7.))*floor(u_time*(3.+6.*h(id)));
float gi=floor(h(id+flick*.37)*64.);
float ink=texture(u_font,(vec2(mod(gi,16.),floor(gi/16.))+g)/vec2(16.,4.)).r;
float t=1.-d/len;
vec3 c=d<1.?vec3(.82,1.,.86):vec3(0.,1.,.255)*(.12+.8*t*t);
o=vec4(c*ink,1.);
}
