import * as THREE from 'three';

/**
 * CameraManipulator — touch/mouse orbit + pan + zoom controller.
 *
 * Port of SceneView's camera-manipulator-compose sample to Three.js/WebXR.
 *
 * Gestures (matches Android SceneView CameraManipulator defaults):
 *  • 1 finger drag  →  orbit  (rotate around target)
 *  • 2 finger drag  →  pan    (translate target + camera)
 *  • Pinch          →  zoom   (dolly along view axis)
 *  • Mouse left     →  orbit
 *  • Mouse right/mid→  pan
 *  • Wheel          →  zoom
 *
 * Usage:
 *   const cm = new CameraManipulator(camera, domElement);
 *   cm.target.set(0, 0, 0);  // orbit pivot
 *   // call cm.update() in your render loop for smooth damping
 */
export class CameraManipulator {
    readonly camera:   THREE.PerspectiveCamera;
    readonly target:   THREE.Vector3 = new THREE.Vector3();

    // ── Tuning ─────────────────────────────────────────────────────────────
    orbitSpeed  = 0.5;   // radians / 100 px
    panSpeed    = 0.002; // world units / px
    zoomSpeed   = 0.1;   // fraction of distance / step
    dampingCoef = 0.12;  // 0 = instant, 1 = no movement (SceneView default ≈ 0.1)
    minDistance = 0.3;
    maxDistance = 50;
    minPolarAngle = 0.05;        // radians from top
    maxPolarAngle = Math.PI - 0.05;

    // ── Internal state ─────────────────────────────────────────────────────
    private _spherical    = new THREE.Spherical();
    private _sphericalDelta = new THREE.Spherical();
    private _panOffset    = new THREE.Vector3();
    private _zoomDelta    = 0;
    private _enabled      = true;

    // Touch state
    private _touches: Record<number, { x: number; y: number }> = {};
    private _lastPinchDist = 0;

    // Mouse state
    private _mouseDown   = false;
    private _mouseBtn    = -1;
    private _lastMouseX  = 0;
    private _lastMouseY  = 0;

    private _domEl: HTMLElement;
    private _bound: Record<string, EventListenerOrEventListenerObject> = {};

    constructor(
        camera:     THREE.PerspectiveCamera,
        domElement: HTMLElement,
    ) {
        this.camera = camera;
        this._domEl = domElement;

        // Initialise spherical from current camera position
        const offset = new THREE.Vector3().subVectors(camera.position, this.target);
        this._spherical.setFromVector3(offset);

        this._attachEvents();
    }

    get enabled(): boolean { return this._enabled; }
    set enabled(v: boolean) {
        this._enabled = v;
        if (!v) {
            this._touches = {};
            this._mouseDown = false;
        }
    }

    /**
     * Call once per frame (render loop) for smooth damping.
     * Not required if dampingCoef === 0.
     */
    update(): void {
        if (!this._enabled) return;

        // Apply deltas with damping (SceneView smooth interpolation)
        this._spherical.theta += this._sphericalDelta.theta * this.dampingCoef;
        this._spherical.phi   += this._sphericalDelta.phi   * this.dampingCoef;
        this._spherical.radius *= 1 + this._zoomDelta       * this.dampingCoef;

        this._sphericalDelta.theta  *= (1 - this.dampingCoef);
        this._sphericalDelta.phi    *= (1 - this.dampingCoef);
        this._zoomDelta             *= (1 - this.dampingCoef);

        // Clamp
        this._spherical.phi    = THREE.MathUtils.clamp(
            this._spherical.phi, this.minPolarAngle, this.maxPolarAngle,
        );
        this._spherical.radius = THREE.MathUtils.clamp(
            this._spherical.radius, this.minDistance, this.maxDistance,
        );
        this._spherical.makeSafe();

        // Pan target
        this.target.addScaledVector(this._panOffset, this.dampingCoef);
        this._panOffset.multiplyScalar(1 - this.dampingCoef);

        // Reconstruct camera position
        const offset = new THREE.Vector3().setFromSpherical(this._spherical);
        this.camera.position.copy(this.target).add(offset);
        this.camera.lookAt(this.target);
    }

    dispose(): void {
        for (const [evt, fn] of Object.entries(this._bound)) {
            this._domEl.removeEventListener(evt, fn as EventListener);
        }
        this._bound = {};
    }

    // ── Event wiring ─────────────────────────────────────────────────────────

    private _attachEvents(): void {
        const on = <K extends keyof HTMLElementEventMap>(
            type: K,
            fn: (e: HTMLElementEventMap[K]) => void,
        ) => {
            this._domEl.addEventListener(type, fn as EventListener, { passive: false });
            this._bound[type] = fn as EventListener;
        };

        // Touch
        on('touchstart',  e => this._onTouchStart(e));
        on('touchmove',   e => this._onTouchMove(e));
        on('touchend',    e => this._onTouchEnd(e));

        // Mouse
        on('mousedown',   e => this._onMouseDown(e));
        on('mousemove',   e => this._onMouseMove(e));
        on('mouseup',     e => { this._mouseDown = false; });
        on('wheel',       e => this._onWheel(e));

        // Prevent context menu on right-click
        on('contextmenu', e => e.preventDefault());
    }

    // ── Touch handlers ────────────────────────────────────────────────────────

    private _onTouchStart(e: TouchEvent): void {
        if (!this._enabled) return;
        e.preventDefault();
        for (const t of Array.from(e.changedTouches)) {
            this._touches[t.identifier] = { x: t.clientX, y: t.clientY };
        }
        if (Object.keys(this._touches).length === 2) {
            this._lastPinchDist = this._pinchDistance();
        }
    }

    private _onTouchMove(e: TouchEvent): void {
        if (!this._enabled) return;
        e.preventDefault();

        const ids = Object.keys(this._touches).map(Number);

        if (ids.length === 1) {
            // ── 1 finger → orbit ──────────────────────────────────────────────
            const t    = Array.from(e.changedTouches).find(t => t.identifier === ids[0]);
            if (!t) return;
            const prev = this._touches[ids[0]];
            const dx   = t.clientX - prev.x;
            const dy   = t.clientY - prev.y;

            this._sphericalDelta.theta -= dx * (this.orbitSpeed / 100) * (Math.PI * 2);
            this._sphericalDelta.phi   -= dy * (this.orbitSpeed / 100) * Math.PI;

            this._touches[ids[0]] = { x: t.clientX, y: t.clientY };

        } else if (ids.length === 2) {
            // ── 2 fingers → pan + pinch-zoom ─────────────────────────────────
            const ts = Array.from(e.changedTouches);

            for (const t of ts) {
                if (this._touches[t.identifier]) {
                    this._touches[t.identifier] = { x: t.clientX, y: t.clientY };
                }
            }

            const newPinch = this._pinchDistance();
            const pinchDelta = newPinch - this._lastPinchDist;
            this._zoomDelta -= (pinchDelta / window.innerHeight) * this.zoomSpeed * 4;
            this._lastPinchDist = newPinch;

            // Pan from midpoint movement
            const [id0, id1] = ids;
            const p0 = this._touches[id0];
            const p1 = this._touches[id1];
            if (p0 && p1) {
                const midX = (p0.x + p1.x) / 2;
                const midY = (p0.y + p1.y) / 2;
                this._applyPan(midX - ((p0.x + p1.x) / 2), midY - ((p0.y + p1.y) / 2));
            }
        }
    }

    private _onTouchEnd(e: TouchEvent): void {
        for (const t of Array.from(e.changedTouches)) {
            delete this._touches[t.identifier];
        }
    }

    private _pinchDistance(): number {
        const ids = Object.keys(this._touches).map(Number);
        if (ids.length < 2) return 0;
        const a = this._touches[ids[0]];
        const b = this._touches[ids[1]];
        return Math.hypot(b.x - a.x, b.y - a.y);
    }

    // ── Mouse handlers ────────────────────────────────────────────────────────

    private _onMouseDown(e: MouseEvent): void {
        if (!this._enabled) return;
        this._mouseDown  = true;
        this._mouseBtn   = e.button;
        this._lastMouseX = e.clientX;
        this._lastMouseY = e.clientY;
    }

    private _onMouseMove(e: MouseEvent): void {
        if (!this._enabled || !this._mouseDown) return;

        const dx = e.clientX - this._lastMouseX;
        const dy = e.clientY - this._lastMouseY;

        if (this._mouseBtn === 0) {
            // Left → orbit
            this._sphericalDelta.theta -= dx * (this.orbitSpeed / 100) * (Math.PI * 2);
            this._sphericalDelta.phi   -= dy * (this.orbitSpeed / 100) * Math.PI;
        } else {
            // Right / middle → pan
            this._applyPan(dx, dy);
        }

        this._lastMouseX = e.clientX;
        this._lastMouseY = e.clientY;
    }

    private _onWheel(e: WheelEvent): void {
        if (!this._enabled) return;
        e.preventDefault();
        const dir = e.deltaY > 0 ? 1 : -1;
        this._zoomDelta += dir * this.zoomSpeed;
    }

    // ── Pan helper ────────────────────────────────────────────────────────────

    private _applyPan(dx: number, dy: number): void {
        const dist    = this._spherical.radius;
        const fovRad  = THREE.MathUtils.degToRad(this.camera.fov);
        const unitPx  = (2 * Math.tan(fovRad / 2) * dist) / window.innerHeight;

        // Right vector from camera
        const right = new THREE.Vector3();
        right.setFromMatrixColumn(this.camera.matrix, 0);

        // Up vector perpendicular to view (projected onto world XZ for floor-aligned pan)
        const up = new THREE.Vector3();
        up.setFromMatrixColumn(this.camera.matrix, 1);

        this._panOffset.addScaledVector(right, -dx * unitPx);
        this._panOffset.addScaledVector(up,     dy * unitPx);
    }
}
