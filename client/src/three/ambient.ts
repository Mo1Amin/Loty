import { Color, Mesh, OrthographicCamera, PlaneGeometry, Scene, ShaderMaterial, Vector2, Vector4, WebGLRenderer } from 'three';

// The room takes on the colour of what is playing: light spills out of each
// edge of the player in that edge's colour, the way a screen lights a dark room.
// One full-screen quad and one fragment shader; rendered at half resolution
// because the result is a blur anyway.

const vertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const fragment = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform vec2 uViewport;     // css px
  uniform vec4 uRect;         // player: x, y, w, h in css px (y from top)
  uniform float uRadius;
  uniform vec3 uTop, uRight, uBottom, uLeft;
  uniform float uIntensity;
  uniform float uTime;
  uniform float uBreath;

  float sdRoundBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

  void main() {
    vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uViewport;
    vec2 half_ = uRect.zw * 0.5;
    vec2 center = uRect.xy + half_;
    vec2 p = px - center;
    float d = sdRoundBox(p, half_, uRadius);

    // Which edge this pixel faces decides its colour.
    vec2 q = p / max(half_, vec2(1.0));
    float wl = max(-q.x, 0.0), wr = max(q.x, 0.0), wt = max(-q.y, 0.0), wb = max(q.y, 0.0);
    wl *= wl; wr *= wr; wt *= wt; wb *= wb;
    vec3 col = (uLeft * wl + uRight * wr + uTop * wt + uBottom * wb) / max(wl + wr + wt + wb, 1e-4);

    // Light reaches about as far as a real screen would light a wall: capped, so a big player does not flood the room.
    float reach = min(max(half_.x, half_.y) * 0.8 + 60.0, 240.0);
    float angle = atan(p.y, p.x);
    reach *= 1.0 + uBreath * 0.06 * sin(uTime * 0.35 + angle * 2.0);
    float glow = exp(-max(d, 0.0) / reach * 1.6) * uIntensity;
    glow *= smoothstep(-40.0, 6.0, d); // nothing under the player itself

    vec3 c = col * glow;
    c += (hash(px + uTime) - 0.5) / 255.0; // dither: no banding in dark gradients
    gl_FragColor = vec4(c, 1.0);
  }
`;

import type { EdgeColors } from './palette.ts';

export class Ambient {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material: ShaderMaterial;
  private target: Color[];
  private current: Color[];
  private intensity = 0;
  private targetIntensity = 0;
  private raf = 0;
  private timeout = 0;
  private lastFrame = 0;
  private readonly still: boolean;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, reduceMotion: boolean) {
    this.still = reduceMotion;
    this.renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(0.5);
    const black = () => new Color(0, 0, 0);
    this.current = [black(), black(), black(), black()];
    this.target = [black(), black(), black(), black()];
    this.material = new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      depthTest: false,
      uniforms: {
        uViewport: { value: new Vector2(1, 1) },
        uRect: { value: new Vector4(0, 0, 0, 0) },
        uRadius: { value: 18 },
        uTop: { value: this.current[0] },
        uRight: { value: this.current[1] },
        uBottom: { value: this.current[2] },
        uLeft: { value: this.current[3] },
        uIntensity: { value: 0 },
        uTime: { value: 0 },
        uBreath: { value: reduceMotion ? 0 : 1 },
      },
    });
    this.scene.add(new Mesh(new PlaneGeometry(2, 2), this.material));
    this.resize();
    document.addEventListener('visibilitychange', this.onVisibility);
    this.kick();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    (this.material.uniforms.uViewport!.value as Vector2).set(w, h);
    this.kick();
  }

  setRect(rect: { x: number; y: number; width: number; height: number } | null, radius = 18) {
    const v = this.material.uniforms.uRect!.value as Vector4;
    if (rect) v.set(rect.x, rect.y, rect.width, rect.height);
    this.material.uniforms.uRadius!.value = radius;
    this.kick();
  }

  setColors(colors: EdgeColors | null, intensity = 0.85) {
    if (colors) this.target = colors.map(([r, g, b]) => new Color(r, g, b));
    this.targetIntensity = colors ? intensity : 0;
    this.kick();
  }

  private onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(this.raf);
      window.clearTimeout(this.timeout);
    } else this.kick();
  };

  private kick() {
    if (this.disposed || document.hidden) return;
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.timeout);
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (t: number) => {
    if (this.disposed) return;
    const dt = Math.min(0.1, (t - (this.lastFrame || t)) / 1000);
    this.lastFrame = t;
    // Critically damped approach, about 0.8 s to settle: colours drift in, never snap.
    const k = this.still ? 1 : 1 - Math.exp(-dt * 5);
    let moving = false;
    for (let i = 0; i < 4; i++) {
      const c = this.current[i]!;
      const g = this.target[i]!;
      c.r += (g.r - c.r) * k;
      c.g += (g.g - c.g) * k;
      c.b += (g.b - c.b) * k;
      if (Math.abs(g.r - c.r) + Math.abs(g.g - c.g) + Math.abs(g.b - c.b) > 0.002) moving = true;
    }
    this.intensity += (this.targetIntensity - this.intensity) * k;
    if (Math.abs(this.targetIntensity - this.intensity) > 0.002) moving = true;

    const u = this.material.uniforms;
    u.uIntensity!.value = this.intensity;
    u.uTime!.value = t / 1000;
    this.renderer.render(this.scene, this.camera);

    // Breathing keeps it alive at ~30 fps; a still room with settled colours stops drawing entirely.
    if (moving) this.raf = requestAnimationFrame(this.frame);
    else if (!this.still && this.intensity > 0.01) this.timeout = window.setTimeout(() => this.kick(), 33);
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.timeout);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.material.dispose();
    this.renderer.dispose();
  }
}
