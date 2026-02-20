import * as THREE from 'three';

interface Particle {
    x: number; y: number; z: number;
    born: number;
    // нормаль поверхности (для размера на стенах)
    onWall: boolean;
}

/**
 * Эфемерные точки трекинга: радиальный круг ⟶ живут 500мс ⟶ гаснут.
 * Shader с ручным управлением размером — одинаково видимы и на полу, и на стене.
 */
export class FeaturePoints {
    private readonly scene: THREE.Scene;
    private readonly geo: THREE.BufferGeometry;
    private readonly posAttr: THREE.BufferAttribute;
    private readonly alphaAttr: THREE.BufferAttribute;
    private readonly sizeAttr: THREE.BufferAttribute;
    private particles: Particle[] = [];

    private static readonly MAX = 512;
    private static readonly LIFETIME = 500;
    private static readonly RADIUS = 0.14;
    private static readonly PER_HIT = 16;
    private static readonly Y_OFFSET = 0.004;

    // Базовый размер точки в пикселях (независим от дистанции)
    private static readonly BASE_PX = 22.0;

    constructor(scene: THREE.Scene) {
        this.scene = scene;

        const pos = new Float32Array(FeaturePoints.MAX * 3);
        const alpha = new Float32Array(FeaturePoints.MAX);
        const size = new Float32Array(FeaturePoints.MAX);

        this.geo = new THREE.BufferGeometry();
        this.posAttr = new THREE.BufferAttribute(pos, 3);
        this.alphaAttr = new THREE.BufferAttribute(alpha, 1);
        this.sizeAttr = new THREE.BufferAttribute(size, 1);
        this.geo.setAttribute('position', this.posAttr);
        this.geo.setAttribute('alpha', this.alphaAttr);
        this.geo.setAttribute('aSize', this.sizeAttr);
        this.geo.setDrawRange(0, 0);

        // Shader: точка со скруглёнными краями, постоянный размер в пикселях
        const mat = new THREE.ShaderMaterial({
            uniforms: {
                uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) }
            },
            vertexShader: `
        attribute float alpha;
        attribute float aSize;
        uniform float uPixelRatio;
        varying float vAlpha;

        void main() {
          vAlpha = alpha;
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          // Размер в пикселях, масштабируем под DPR и дистанцию (мягко)
          float dist  = -mvPos.z;
          float scale = max(0.4, 1.0 / (dist * 0.5 + 0.5)); // не даём стать совсем крошечными
          gl_PointSize = aSize * scale * uPixelRatio;
          gl_Position  = projectionMatrix * mvPos;
        }
      `,
            fragmentShader: `
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          // Мягкий край
          float edge = 1.0 - smoothstep(0.35, 0.5, d);
          gl_FragColor = vec4(1.0, 1.0, 1.0, vAlpha * edge);
        }
      `,
            transparent: true,
            depthWrite: false
        });

        const pts = new THREE.Points(this.geo, mat);
        pts.frustumCulled = false;
        scene.add(pts);
    }

    addPoint(pos: THREE.Vector3, onWall: boolean, nowMs: number = performance.now()): void {
        const n = FeaturePoints.PER_HIT;
        // Для стен — добавляем точки в плоскости стены, а не по кругу на полу
        for (let i = 0; i < n; i++) {
            const angle = (i / n) * Math.PI * 2;
            const r = FeaturePoints.RADIUS * (0.35 + Math.random() * 0.65);
            this.particles.push({
                x: pos.x + Math.cos(angle) * r,
                y: pos.y + (onWall ? Math.sin(angle) * r : FeaturePoints.Y_OFFSET),
                z: pos.z + (onWall ? FeaturePoints.Y_OFFSET : Math.sin(angle) * r),
                born: nowMs,
                onWall
            });
        }
    }

    update(nowMs: number = performance.now()): void {
        const cutoff = nowMs - FeaturePoints.LIFETIME;
        this.particles = this.particles.filter(p => p.born > cutoff);
        if (this.particles.length > FeaturePoints.MAX) {
            this.particles = this.particles.slice(-FeaturePoints.MAX);
        }

        const n = this.particles.length;
        const posArr = this.posAttr.array as Float32Array;
        const alArr = this.alphaAttr.array as Float32Array;
        const szArr = this.sizeAttr.array as Float32Array;

        for (let i = 0; i < n; i++) {
            const p = this.particles[i];
            const age = Math.max(0, (nowMs - p.born) / FeaturePoints.LIFETIME);
            // Пульс: нарастает → гаснет
            const a = Math.sin(age * Math.PI);

            posArr[i * 3] = p.x;
            posArr[i * 3 + 1] = p.y;
            posArr[i * 3 + 2] = p.z;
            alArr[i] = a * 0.95;
            szArr[i] = FeaturePoints.BASE_PX * (0.5 + a * 0.5);
        }

        this.posAttr.needsUpdate = true;
        this.alphaAttr.needsUpdate = true;
        this.sizeAttr.needsUpdate = true;
        this.geo.setDrawRange(0, n);
    }

    clear(): void {
        this.particles = [];
        this.geo.setDrawRange(0, 0);
    }

    dispose(): void {
        this.scene.clear(); // only removes from scene if referenced
        this.geo.dispose();
    }
}
