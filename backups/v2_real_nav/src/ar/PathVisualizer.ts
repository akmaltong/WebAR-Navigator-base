import * as THREE from 'three';

/**
 * Визуализация маршрута: лента из шевронов (V-формы) на полу.
 * Анимация: волна непрозрачности бежит от точки 0 к точке 1 (старт→финиш).
 * Реализовано через custom ShaderMaterial + атрибут progress (0..1 вдоль пути).
 */
export class PathVisualizer {
    private readonly scene: THREE.Scene;
    private mesh?: THREE.Mesh;
    private material?: THREE.ShaderMaterial;
    private animId = 0;
    private startTime = 0;

    // ── Настройки ────────────────────────────────────────────────────────────
    private static readonly SPACING = 0.20;  // м между шевронами
    private static readonly CHEVRON_W = 0.13;  // ширина шеврона (м)
    private static readonly CHEVRON_H = 0.16;  // «глубина» V (м)
    private static readonly THICKNESS = 0.04;  // толщина «плеч» шеврона
    private static readonly FLOOR_Y = 0.012; // высота над полом (м)
    private static readonly COLOR_R = 0.0;
    private static readonly COLOR_G = 1.0;
    private static readonly COLOR_B = 0.53;
    private static readonly WAVE_SPEED = 2.8;   // скорость анимации
    private static readonly WAVE_FREQ = 14.0;  // частота волны

    constructor(scene: THREE.Scene) {
        this.scene = scene;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    drawPath(points: THREE.Vector3[]): void {
        this.clear();
        if (points.length < 2) return;

        const { positions, progresses } = this._buildGeometry(points);
        if (positions.length === 0) return;

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
        geo.setAttribute('progress', new THREE.BufferAttribute(new Float32Array(progresses), 1));

        this.material = new THREE.ShaderMaterial({
            uniforms: { uTime: { value: 0.0 } },
            vertexShader: /* glsl */`
        attribute float progress;
        varying   float vProgress;
        void main() {
          vProgress   = progress;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
            fragmentShader: /* glsl */`
        uniform float uTime;
        varying float vProgress;

        void main() {
          // Волна бежит от progress=0 (старт) к progress=1 (финиш)
          float wave = sin(vProgress * ${PathVisualizer.WAVE_FREQ.toFixed(1)} - uTime * ${PathVisualizer.WAVE_SPEED.toFixed(1)});
          // Нижний предел яркости 0.15 (шевроны всегда чуть видны)
          float alpha = clamp(wave * 0.5 + 0.65, 0.15, 1.0);
          gl_FragColor = vec4(
            ${PathVisualizer.COLOR_R.toFixed(1)},
            ${PathVisualizer.COLOR_G.toFixed(1)},
            ${PathVisualizer.COLOR_B.toFixed(2)},
            alpha
          );
        }
      `,
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide
        });

        this.mesh = new THREE.Mesh(geo, this.material);
        this.mesh.frustumCulled = false;
        this.scene.add(this.mesh);

        this.startTime = performance.now();
        this._animate();
    }

    clear(): void {
        cancelAnimationFrame(this.animId);
        this.animId = 0;
        if (this.mesh) {
            this.scene.remove(this.mesh);
            this.mesh.geometry.dispose();
            this.material?.dispose();
            this.mesh = undefined;
            this.material = undefined;
        }
    }

    dispose(): void { this.clear(); }

    // ── Animation ─────────────────────────────────────────────────────────────

    private _animate(): void {
        const tick = () => {
            if (!this.material) return;
            this.material.uniforms.uTime.value = (performance.now() - this.startTime) / 1000.0;
            this.animId = requestAnimationFrame(tick);
        };
        this.animId = requestAnimationFrame(tick);
    }

    // ── Geometry builder ──────────────────────────────────────────────────────

    private _buildGeometry(points: THREE.Vector3[]): {
        positions: number[];
        progresses: number[];
    } {
        // Вычисляем суммарную длину пути
        const segLengths: number[] = [];
        let totalLen = 0;
        for (let i = 1; i < points.length; i++) {
            const l = points[i].distanceTo(points[i - 1]);
            segLengths.push(l);
            totalLen += l;
        }
        if (totalLen < 0.001) return { positions: [], progresses: [] };

        const positions: number[] = [];
        const progresses: number[] = [];

        const W = PathVisualizer.CHEVRON_W;
        const H = PathVisualizer.CHEVRON_H;
        const T = PathVisualizer.THICKNESS;
        const Y = PathVisualizer.FLOOR_Y;
        const SP = PathVisualizer.SPACING;

        let distSoFar = 0;
        let nextPos = SP * 0.4; // первый шеврон немного от старта

        const up = new THREE.Vector3(0, 1, 0);

        for (let seg = 0; seg < segLengths.length; seg++) {
            const a = points[seg];
            const b = points[seg + 1];
            const len = segLengths[seg];

            // Направление сегмента (пересчитываем внутри цикла для точности)
            // Направление сегмента
            const dir = new THREE.Vector3().subVectors(b, a).normalize();
            const right = new THREE.Vector3().crossVectors(dir, up).normalize();

            while (nextPos <= distSoFar + len) {

                const t_local = (nextPos - distSoFar) / len;
                const t_global = nextPos / totalLen;          // 0 (старт) → 1 (финиш)

                const center = new THREE.Vector3().lerpVectors(a, b, t_local);
                // Реальный Y пола из hit-test + маленькое смещение
                const floorY = center.y + PathVisualizer.FLOOR_Y;

                // ── Геометрия шеврона (вид сверху, ось dir = вперёд) ──
                //
                //           tip
                //           /\
                //          /  \
                //        iL    iR
                //       /        \
                //     bL          bR
                //
                // Плечи — заполненные прямоугольники (трапеции)
                // Left arm:  tip→bL, Right arm: tip→bR

                const tip = center.clone().add(dir.clone().multiplyScalar(H * 0.55)); tip.y = floorY;
                const bL = center.clone()
                    .sub(dir.clone().multiplyScalar(H * 0.45))
                    .add(right.clone().multiplyScalar(W)); bL.y = floorY;
                const bR = center.clone()
                    .sub(dir.clone().multiplyScalar(H * 0.45))
                    .sub(right.clone().multiplyScalar(W)); bR.y = floorY;
                const tiL = tip.clone().add(right.clone().multiplyScalar(T)); tiL.y = floorY;
                const tiR = tip.clone().sub(right.clone().multiplyScalar(T)); tiR.y = floorY;
                const biL = bL.clone().sub(right.clone().multiplyScalar(T * 0.7)); biL.y = floorY;
                const biR = bR.clone().add(right.clone().multiplyScalar(T * 0.7)); biR.y = floorY;

                // Левое плечо: tip(outer) → tiL → biL → bL(outer) → два треугольника
                //   tri1: tip, bL, biL
                //   tri2: tip, biL, tiL
                // — но так как tip = tiL‐объединён в точке, это «трапеция»

                const addTri = (v1: THREE.Vector3, v2: THREE.Vector3, v3: THREE.Vector3) => {
                    positions.push(v1.x, v1.y, v1.z, v2.x, v2.y, v2.z, v3.x, v3.y, v3.z);
                    progresses.push(t_global, t_global, t_global);
                };

                // Левое плечо (4 вершины → 2 треугольника)
                addTri(tip, bL, biL);
                addTri(tip, biL, tiL);

                // Правое плечо
                addTri(tip, biR, bR);
                addTri(tip, tiR, biR);

                nextPos += SP;
            }

            distSoFar += len;
        }

        return { positions, progresses };
    }
}
