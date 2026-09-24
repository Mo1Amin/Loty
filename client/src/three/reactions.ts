import { CanvasTexture, OrthographicCamera, Scene, Sprite, SpriteMaterial, SRGBColorSpace, WebGLRenderer } from 'three';

// Reactions rise from the bottom of the player for everyone at once.
// Each one is a sprite driven by a little physics: an upward throw that slows,
// a sideways sway, and a scale spring that overshoots once — the gesture
// (a tap) carried intent, so a small bounce is earned here.

interface Particle {
  sprite: Sprite;
  x: number;
  y: number;
  vy: number;
  sway: number;
  phase: number;
  age: number;
  life: number;
  scale: number;
  scaleV: number;
  size: number;
}

const textures = new Map<string, CanvasTexture>();

function emojiTexture(emoji: string): CanvasTexture {
  const cached = textures.get(emoji);
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '100px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
  ctx.fillText(emoji, 64, 72);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  textures.set(emoji, t);
  return t;
}

export class ReactionLayer {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new OrthographicCamera(0, 1, 1, 0, -10, 10);
  private particles: Particle[] = [];
  private raf = 0;
  private last = 0;
  private w = 1;
  private h = 1;
  private readonly still: boolean;
  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement, reduceMotion: boolean) {
    this.still = reduceMotion;
    this.canvas = canvas;
    this.renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setClearColor(0x000000, 0);
  }

  resize(width: number, height: number) {
    this.w = Math.max(1, width);
    this.h = Math.max(1, height);
    this.renderer.setSize(this.w, this.h, false);
    // Pixel space with y up; particle positions are kept y-down like CSS and converted when drawn.
    this.camera.left = 0;
    this.camera.right = this.w;
    this.camera.top = this.h;
    this.camera.bottom = 0;
    this.camera.updateProjectionMatrix();
  }

  burst(emoji: string) {
    if (this.particles.length > 60) return; // a flood stays readable
    const material = new SpriteMaterial({ map: emojiTexture(emoji), transparent: true, depthTest: false });
    const sprite = new Sprite(material);
    const size = Math.max(34, Math.min(64, this.w * 0.07)) * (0.85 + Math.random() * 0.3);
    const p: Particle = {
      sprite,
      x: this.w * (0.12 + Math.random() * 0.76),
      y: this.h - size * 0.2,
      vy: -(this.h * 0.55 + Math.random() * this.h * 0.25),
      sway: (Math.random() - 0.5) * 36,
      phase: Math.random() * Math.PI * 2,
      age: 0,
      life: this.still ? 1.6 : 2.4 + Math.random() * 0.5,
      scale: this.still ? 1 : 0,
      scaleV: 0,
      size,
    };
    if (this.still) p.y = this.h * (0.45 + Math.random() * 0.3);
    this.scene.add(sprite);
    this.particles.push(p);
    this.start();
  }

  private start() {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (t: number) => {
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;
      p.age += dt;
      if (!this.still) {
        // Thrown upwards, slowed by drag: fast off the finger, drifting at the top.
        p.vy *= Math.exp(-dt * 1.4);
        p.y += p.vy * dt;
        // Scale spring toward 1: stiffness 260, damping ratio ~0.55 → one soft overshoot.
        const k = 260;
        const c = 2 * 0.55 * Math.sqrt(k);
        p.scaleV += (k * (1 - p.scale) - c * p.scaleV) * dt;
        p.scale += p.scaleV * dt;
      }
      const x = p.x + Math.sin(p.phase + p.age * 3.2) * p.sway * Math.min(1, p.age * 2);
      const fadeIn = this.still ? Math.min(1, p.age / 0.2) : 1;
      const fadeOut = Math.min(1, (p.life - p.age) / 0.6);
      const alpha = Math.max(0, Math.min(fadeIn, fadeOut));
      p.sprite.position.set(x, this.h - p.y, 0);
      const s = p.size * Math.max(0, p.scale);
      p.sprite.scale.set(s, s, 1);
      (p.sprite.material as SpriteMaterial).opacity = alpha;
      if (p.age >= p.life) {
        this.scene.remove(p.sprite);
        (p.sprite.material as SpriteMaterial).dispose();
        this.particles.splice(i, 1);
      }
    }
    this.renderer.render(this.scene, this.camera);
    this.canvas.dataset.live = String(this.particles.length);
    if (this.particles.length > 0) this.raf = requestAnimationFrame(this.frame);
    else {
      this.raf = 0;
      this.renderer.clear();
    }
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    for (const p of this.particles) (p.sprite.material as SpriteMaterial).dispose();
    this.particles = [];
    this.renderer.dispose();
  }
}
