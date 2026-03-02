import * as THREE from 'three';

export type GizmoMode = 'translate' | 'rotate' | 'scale' | 'off';

/**
 * GizmoController — 3D-гизмо для прямого управления геометрией через тач.
 * 
 * Визуально:
 *  - 3 стрелки осей (X=красный, Y=зелёный, Z=синий)
 *  - Кольцо вращения (жёлтое) вокруг Y
 *  - Куб масштабирования (оранжевый) в центре
 * 
 * Управление:
 *  - Translate: 1-палец drag → двигает по XZ, 2-палец вертикальный drag → Y
 *  - Rotate:    1-палец горизонтальный drag → вращение вокруг Y
 *  - Scale:     pinch (2 пальца) → масштабирование
 */
export class GizmoController {
    private readonly scene: THREE.Scene;
    private readonly camera: THREE.Camera;
    private readonly target: THREE.Group;
    private readonly domEl: HTMLElement;

    /** Визуальная группа гизмо */
    readonly gizmo = new THREE.Group();

    private _mode: GizmoMode = 'off';
    private _visible = false;

    // Touch state
    private _touching = false;
    private _touchId = -1;
    private _lastX = 0;
    private _lastY = 0;
    private _touches: Map<number, { x: number; y: number }> = new Map();
    private _lastPinchDist = 0;
    private _initialScale = 1;

    // Sensitivity
    private static readonly TRANSLATE_SPEED = 0.003;
    private static readonly ROTATE_SPEED = 0.008;
    private static readonly SCALE_SPEED = 0.005;

    // Gizmo parts for pulsing
    private _translateParts: THREE.Object3D[] = [];
    private _rotateParts: THREE.Object3D[] = [];
    private _scaleParts: THREE.Object3D[] = [];
    private _centerSphere?: THREE.Mesh;

    constructor(
        scene: THREE.Scene,
        camera: THREE.Camera,
        target: THREE.Group,
        domElement: HTMLElement
    ) {
        this.scene = scene;
        this.camera = camera;
        this.target = target;
        this.domEl = domElement;

        this._buildGizmo();
        this.scene.add(this.gizmo);
        this.gizmo.visible = false;

        this._attachTouch();
    }

    // ── Mode ─────────────────────────────────────────────────────────────────

    get mode(): GizmoMode { return this._mode; }

    set mode(m: GizmoMode) {
        this._mode = m;
        this._updateVisual();
    }

    get visible(): boolean { return this._visible; }

    show(): void {
        this._visible = true;
        this.gizmo.visible = true;
    }

    hide(): void {
        this._visible = false;
        this.gizmo.visible = false;
    }

    toggle(): void {
        this._visible ? this.hide() : this.show();
    }

    // ── Update (call each frame) ─────────────────────────────────────────────

    update(time: number): void {
        if (!this._visible) return;

        // Follow target position
        this.gizmo.position.copy(this.target.position);

        // Auto-scale gizmo based on distance to camera
        const camPos = new THREE.Vector3();
        if ((this.camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
            camPos.setFromMatrixPosition(this.camera.matrixWorld);
        }
        const dist = camPos.distanceTo(this.gizmo.position);
        const gizmoScale = Math.max(0.08, Math.min(dist * 0.15, 0.4));
        this.gizmo.scale.setScalar(gizmoScale);

        // Pulsing effect for active mode
        const pulse = 0.85 + 0.15 * Math.sin(time / 200);
        const parts = this._mode === 'translate' ? this._translateParts
            : this._mode === 'rotate' ? this._rotateParts
                : this._mode === 'scale' ? this._scaleParts
                    : [];

        parts.forEach(p => {
            p.traverse(c => {
                if (c instanceof THREE.Mesh || c instanceof THREE.Line) {
                    const mat = (c as any).material;
                    if (mat && 'opacity' in mat) {
                        mat.opacity = pulse;
                    }
                }
            });
        });

        // Center sphere color indicates mode
        if (this._centerSphere) {
            const mat = this._centerSphere.material as THREE.MeshBasicMaterial;
            if (this._mode === 'translate') mat.color.setHex(0x00ff88);
            else if (this._mode === 'rotate') mat.color.setHex(0xffdd00);
            else if (this._mode === 'scale') mat.color.setHex(0xff8800);
            else mat.color.setHex(0xffffff);
        }
    }

    // ── Build Visual Gizmo ───────────────────────────────────────────────────

    private _buildGizmo(): void {
        // Center sphere
        const centerGeo = new THREE.SphereGeometry(0.12, 16, 16);
        const centerMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.7,
            depthWrite: false,
        });
        this._centerSphere = new THREE.Mesh(centerGeo, centerMat);
        this.gizmo.add(this._centerSphere);

        // Translation arrows (X=red, Y=green, Z=blue)
        this._translateParts.push(this._makeArrow(new THREE.Vector3(1, 0, 0), 0xff4444));
        this._translateParts.push(this._makeArrow(new THREE.Vector3(0, 1, 0), 0x44ff44));
        this._translateParts.push(this._makeArrow(new THREE.Vector3(-0, 0, 1), 0x4488ff));

        // Rotation ring (yellow torus around Y)
        const torusGeo = new THREE.TorusGeometry(0.8, 0.03, 12, 48);
        const torusMat = new THREE.MeshBasicMaterial({
            color: 0xffdd00,
            transparent: true,
            opacity: 0.6,
            depthWrite: false,
            side: THREE.DoubleSide,
        });
        const torus = new THREE.Mesh(torusGeo, torusMat);
        torus.rotation.x = Math.PI / 2; // lie flat on XZ plane
        this.gizmo.add(torus);
        this._rotateParts.push(torus);

        // Scale indicator (small cubes on each axis end)
        const cubeGeo = new THREE.BoxGeometry(0.12, 0.12, 0.12);
        const cubeMat = new THREE.MeshBasicMaterial({
            color: 0xff8800,
            transparent: true,
            opacity: 0.7,
            depthWrite: false,
        });
        const positions = [
            [0.9, 0, 0], [-0.9, 0, 0],
            [0, 0.9, 0], [0, -0.9, 0],
            [0, 0, 0.9], [0, 0, -0.9],
        ];
        positions.forEach(([x, y, z]) => {
            const cube = new THREE.Mesh(cubeGeo, cubeMat.clone());
            cube.position.set(x, y, z);
            this.gizmo.add(cube);
            this._scaleParts.push(cube);
        });
    }

    private _makeArrow(dir: THREE.Vector3, color: number): THREE.Group {
        const group = new THREE.Group();

        // Shaft (line)
        const shaftGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 0),
            dir.clone().multiplyScalar(0.8),
        ]);
        const shaftMat = new THREE.LineBasicMaterial({
            color,
            linewidth: 3,
            transparent: true,
            opacity: 0.8,
            depthWrite: false,
        });
        const shaft = new THREE.Line(shaftGeo, shaftMat);
        group.add(shaft);

        // Head (cone)
        const coneGeo = new THREE.ConeGeometry(0.06, 0.18, 8);
        const coneMat = new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.8,
            depthWrite: false,
        });
        const cone = new THREE.Mesh(coneGeo, coneMat);
        cone.position.copy(dir.clone().multiplyScalar(0.9));

        // Orient cone along direction
        const up = new THREE.Vector3(0, 1, 0);
        const quat = new THREE.Quaternion().setFromUnitVectors(up, dir.clone().normalize());
        cone.setRotationFromQuaternion(quat);

        group.add(cone);
        this.gizmo.add(group);
        return group;
    }

    private _updateVisual(): void {
        const dimOpacity = 0.15;
        const fullOpacity = 0.8;

        const setGroupOpacity = (parts: THREE.Object3D[], active: boolean) => {
            parts.forEach(p => p.traverse(c => {
                if ((c as any).material) {
                    const mat = (c as any).material;
                    if ('opacity' in mat) mat.opacity = active ? fullOpacity : dimOpacity;
                }
            }));
        };

        setGroupOpacity(this._translateParts, this._mode === 'translate');
        setGroupOpacity(this._rotateParts, this._mode === 'rotate');
        setGroupOpacity(this._scaleParts, this._mode === 'scale');
    }

    // ── Touch Handling ───────────────────────────────────────────────────────

    private _attachTouch(): void {
        const el = this.domEl;

        el.addEventListener('touchstart', (e) => this._onTouchStart(e), { passive: false });
        el.addEventListener('touchmove', (e) => this._onTouchMove(e), { passive: false });
        el.addEventListener('touchend', (e) => this._onTouchEnd(e), { passive: false });
        el.addEventListener('touchcancel', (e) => this._onTouchEnd(e), { passive: false });
    }

    private _onTouchStart(e: TouchEvent): void {
        if (this._mode === 'off' || !this._visible) return;

        for (const t of Array.from(e.changedTouches)) {
            this._touches.set(t.identifier, { x: t.clientX, y: t.clientY });
        }

        if (this._touches.size === 1) {
            const t = e.changedTouches[0];
            this._touching = true;
            this._touchId = t.identifier;
            this._lastX = t.clientX;
            this._lastY = t.clientY;
        }

        if (this._touches.size === 2) {
            this._lastPinchDist = this._pinchDist();
            this._initialScale = this.target.scale.x;
        }
    }

    private _onTouchMove(e: TouchEvent): void {
        if (this._mode === 'off' || !this._visible) return;

        // Update stored touches
        for (const t of Array.from(e.changedTouches)) {
            if (this._touches.has(t.identifier)) {
                this._touches.set(t.identifier, { x: t.clientX, y: t.clientY });
            }
        }

        const numTouches = this._touches.size;

        // ── Scale mode: always use pinch if 2 fingers ────────────────────
        if (this._mode === 'scale' && numTouches >= 2) {
            e.preventDefault();
            const newDist = this._pinchDist();
            if (this._lastPinchDist > 0) {
                const ratio = newDist / this._lastPinchDist;
                const newScale = Math.max(0.01, Math.min(this._initialScale * ratio, 5));
                this.target.scale.setScalar(newScale);
            }
            this._lastPinchDist = newDist;
            return;
        }

        // ── 1-finger gestures ────────────────────────────────────────────
        if (!this._touching || numTouches !== 1) return;

        const t = Array.from(e.changedTouches).find(t => t.identifier === this._touchId);
        if (!t) return;

        e.preventDefault();

        const dx = t.clientX - this._lastX;
        const dy = t.clientY - this._lastY;
        this._lastX = t.clientX;
        this._lastY = t.clientY;

        switch (this._mode) {
            case 'translate':
                this._handleTranslate(dx, dy);
                break;
            case 'rotate':
                this._handleRotate(dx);
                break;
            case 'scale':
                this._handleScaleDrag(dy);
                break;
        }
    }

    private _onTouchEnd(e: TouchEvent): void {
        for (const t of Array.from(e.changedTouches)) {
            this._touches.delete(t.identifier);
            if (t.identifier === this._touchId) {
                this._touching = false;
            }
        }
        if (this._touches.size < 2) {
            this._lastPinchDist = 0;
        }
    }

    // ── Transform Handlers ───────────────────────────────────────────────────

    private _handleTranslate(dx: number, dy: number): void {
        // Get camera forward and right vectors projected on XZ plane
        const camMatrix = this.camera.matrixWorld;
        const forward = new THREE.Vector3(0, 0, -1).applyMatrix4(
            new THREE.Matrix4().extractRotation(camMatrix)
        );
        forward.y = 0;
        forward.normalize();

        const right = new THREE.Vector3(1, 0, 0).applyMatrix4(
            new THREE.Matrix4().extractRotation(camMatrix)
        );
        right.y = 0;
        right.normalize();

        const speed = GizmoController.TRANSLATE_SPEED;

        // Horizontal drag → move along camera-right (world XZ)
        this.target.position.addScaledVector(right, dx * speed);
        // Vertical drag → move along camera-forward (world XZ)
        this.target.position.addScaledVector(forward, -dy * speed);
    }

    private _handleRotate(dx: number): void {
        this.target.rotation.y += dx * GizmoController.ROTATE_SPEED;
    }

    private _handleScaleDrag(dy: number): void {
        const delta = -dy * GizmoController.SCALE_SPEED;
        const current = this.target.scale.x;
        const newScale = Math.max(0.01, Math.min(current + delta, 5));
        this.target.scale.setScalar(newScale);
    }

    private _pinchDist(): number {
        const vals = Array.from(this._touches.values());
        if (vals.length < 2) return 0;
        return Math.hypot(vals[1].x - vals[0].x, vals[1].y - vals[0].y);
    }

    // ── Dispose ──────────────────────────────────────────────────────────────

    dispose(): void {
        this.scene.remove(this.gizmo);
        this.gizmo.traverse(c => {
            if (c instanceof THREE.Mesh || c instanceof THREE.Line) {
                (c as THREE.Mesh).geometry?.dispose();
                const mat = (c as any).material;
                if (mat?.dispose) mat.dispose();
            }
        });
    }
}
