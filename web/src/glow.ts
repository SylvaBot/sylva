// The moving moss glow behind the landing page's hero and closing section.
// One small WebGL shader: two layers of drifting noise fold into each other,
// brightest at the bottom and fading out towards the top. It renders at half
// size (the fog is soft anyway), at most 30 frames a second, and only while
// the canvas is on screen and the tab is visible. Without WebGL the CSS
// blobs underneath stay as a still fallback; with Reduce motion it draws one
// still frame.

const VERT = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';

const FRAG = `precision mediump float;
uniform vec2 r;uniform float t;uniform vec3 base;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
return mix(mix(h(i),h(i+vec2(1.,0.)),f.x),mix(h(i+vec2(0.,1.)),h(i+vec2(1.,1.)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*n(p);p=p*2.02+vec2(1.7,9.2);a*=.5;}return v;}
void main(){
vec2 uv=gl_FragCoord.xy/r;
vec2 p=vec2(uv.x*r.x/r.y,uv.y)*1.6;
float s=t*.035;
vec2 q=vec2(fbm(p+vec2(s,-s*.6)),fbm(p+vec2(-s*.8,s*.5)+4.3));
float f=fbm(p+q*1.8+vec2(s*.7,-s*.2));
float m=smoothstep(.8,.04,uv.y);
float g=smoothstep(.3,.82,f)*m;
vec3 c=mix(base,vec3(.11,.16,.09),m*.85);
c=mix(c,vec3(.42,.55,.33),g*.9);
c=mix(c,vec3(.84,.94,.76),pow(g,2.6)*.7);
gl_FragColor=vec4(c,1.);
}`;

function hex(color: string): [number, number, number] {
  const v = parseInt(color.replace('#', ''), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** Starts the glow on a canvas. Returns a function that stops it. */
export function startGlow(canvas: HTMLCanvasElement): () => void {
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' });
  if (!gl) return () => {};
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
  };
  const vs = shader(gl.VERTEX_SHADER, VERT);
  const fs = shader(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return () => {};
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return () => {};
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'a');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const uRes = gl.getUniformLocation(prog, 'r');
  const uTime = gl.getUniformLocation(prog, 't');
  gl.uniform3fv(gl.getUniformLocation(prog, 'base'), hex(canvas.dataset.base || '#0a0a0a'));

  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // A random start so the fog is not the same shape on every visit.
  const offset = Math.random() * 500;
  let frame = 0;
  let last = 0;
  let visible = false;

  const size = () => {
    const w = Math.max(1, Math.round(canvas.clientWidth / 2));
    const h = Math.max(1, Math.round(canvas.clientHeight / 2));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    gl.uniform2f(uRes, w, h);
  };
  const draw = (now: number) => {
    size();
    gl.uniform1f(uTime, offset + now / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    canvas.classList.add('on');
  };
  const loop = (now: number) => {
    frame = 0;
    if (!visible || document.hidden) return;
    if (now - last >= 33) {
      last = now;
      draw(now);
    }
    frame = requestAnimationFrame(loop);
  };
  const kick = () => {
    if (still) draw(0);
    else if (!frame && visible && !document.hidden) frame = requestAnimationFrame(loop);
  };
  const io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    kick();
  });
  io.observe(canvas);
  const ro = new ResizeObserver(() => still && visible && draw(0));
  ro.observe(canvas);
  document.addEventListener('visibilitychange', kick);
  return () => {
    io.disconnect();
    ro.disconnect();
    document.removeEventListener('visibilitychange', kick);
    if (frame) cancelAnimationFrame(frame);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  };
}
