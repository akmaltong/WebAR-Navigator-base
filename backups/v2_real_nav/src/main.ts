
import * as THREE from 'three';
import { WebARSession } from './core/WebARSession';
import { FeaturePoints } from './ar/FeaturePoints';
import { PathVisualizer } from './ar/PathVisualizer';
import { bezierSpline } from './utils/BezierSpline';

const HIT_MIN_DIST = 0.15;
const MARKER_COLORS = [0x00ff88, 0x4488ff, 0xff8800, 0xff44aa, 0xffdd00];

type Phase = 'loading' | 'ar-entry' | 'placing' | 'navigating';

class ARNavigator {
    private readonly ar: WebARSession;
    private readonly fp: FeaturePoints;
    private readonly pv: PathVisualizer;

    private hitTestSource: XRHitTestSource | null = null;
    private refSpace: XRReferenceSpace | null = null;
    private viewerSpace: XRReferenceSpace | null = null;
    private sessionReady = false;

    private phase: Phase = 'loading';
    private waypoints: THREE.Vector3[] = [];
    private markers: THREE.Group[] = [];

    // ── UI refs ───────────────────────────────────────────────────────────────
    private readonly $loading  = document.getElementById('loading-screen')!;
    private readonly $arEntry  = document.getElementById('ar-entry')!;
    private readonly $badge    = document.getElementById('ar-badge')!;
    private readonly $guide    = document.getElementById('step-guide')!;
    private readonly $stepText = document.getElementById('step-text')!;
    private readonly $btnAdd   = document.getElementById('btn-add')   as HTMLButtonElement;
    private readonly $btnRoute = document.getElementById('btn-route') as HTMLButtonElement;
    private readonly $btnReset = document.getElementById('btn-reset') as HTMLButtonElement;
    private readonly $wpCount  = document.getElementById('wp-count')!;
    private readonly $wpDots   = document.getElementById('wp-dots')!;
    private readonly $status   = document.getElementById('status')!;

    constructor() {
        const container = document.getElementById('ar-container')!;
        this.ar = new WebARSession(container);
        this.fp = new FeaturePoints(this.ar.scene);
        this.pv = new PathVisualizer(this.ar.scene);

        this._bindEvents();
        this._init();
    }

    private async _init(): Promise<void> {
        // Скрываем загрузку сразу — не ждём AR инициализацию
        setTimeout(() => this.$loading.classList.add('hidden'), 600);
        this.phase = 'ar-entry';
        this.$arEntry.classList.add('on');
        this.ar.animate((t, f) => this._onRender(t, f));

        // AR инициализация в фоне
        const arOk = await this.ar.initializeAR();
        if (!arOk) this._showStatus('WebXR AR недоступен. Нужен Chrome на Android.', 'error');
    }

    private _bindEvents(): void {
        document.getElementById('btn-enter-ar')!
            .addEventListener('click', () => this.ar.triggerAREntry());

        this.$btnAdd.addEventListener('click',   () => this._addWaypoint());
        this.$btnRoute.addEventListener('click', () => this._buildRoute());
        this.$btnReset.addEventListener('click', () => this._reset());
    }

    // ── Frame loop ────────────────────────────────────────────────────────────

    private _onRender(time: number, frame: XRFrame | undefined): void {
        this.fp.update(time);

        const arActive = this.ar.isARActive;

        // AR session started
        if (arActive && this.phase === 'ar-entry') {
            this.phase = 'placing';
            this.$arEntry.classList.remove('on');
            this.$badge.classList.add('on');
            this.$guide.classList.add('on');
            this._updateUI();
        }

        // AR session ended
        if (!arActive && (this.phase === 'placing' || this.phase === 'navigating')) {
            this.phase = 'ar-entry';
            this.$badge.classList.remove('on');
            this.$guide.classList.remove('on');
            this.$arEntry.classList.add('on');
            this.ar.reticle.visible = false;
            this.sessionReady = false;
            this.hitTestSource = null;
            this.refSpace = null;
        }

        if (!frame || !arActive) return;
        if (this.phase === 'navigating') return; // route done — no hit-test needed

        // One-time hit-test setup
        if (!this.sessionReady) {
            this.sessionReady = true;
            this._setupHitTest(frame.session);
        }
        if (!this.hitTestSource || !this.refSpace) return;

        const hits = frame.getHitTestResults(this.hitTestSource);
        if (!hits.length) {
            this.ar.reticle.visible = false;
            this.fp.clear();
            return;
        }

        const pose = hits[0].getPose(this.refSpace);
        if (!pose) return;

        const m      = new THREE.Matrix4().fromArray(pose.transform.matrix);
        const pos    = new THREE.Vector3().setFromMatrixPosition(m);
        const normal = new THREE.Vector3(m.elements[4], m.elements[5], m.elements[6]).normalize();

        const camPos = new THREE.Vector3().setFromMatrixPosition(this.ar.camera.matrixWorld);
        if (pos.distanceTo(camPos) < HIT_MIN_DIST) {
            this.ar.reticle.visible = false;
            return;
        }

        this.ar.reticle.visible = true;
        this.ar.reticle.position.copy(pos);
        const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
        this.ar.reticle.setRotationFromQuaternion(quat);
        this.ar.reticle.scale.setScalar(1.0 + 0.08 * Math.sin(time / 150));
        this.fp.updatePose(pos, quat, time);
    }

    // ── Waypoint actions ─────────────────────────────────────────────────────

    private _addWaypoint(): void {
        if (!this.ar.reticle.visible) {
            this._showStatus('Наведи камеру на поверхность', 'error');
            return;
        }

        const pos = this.ar.reticle.position.clone();
        this.waypoints.push(pos);

        const color = MARKER_COLORS[(this.waypoints.length - 1) % MARKER_COLORS.length];
        this.markers.push(this._makeMarker(pos, color, String(this.waypoints.length)));

        this._updateUI();
        this._showStatus(`Точка ${this.waypoints.length} добавлена`, 'success');
    }

    private _buildRoute(): void {
        if (this.waypoints.length < 2) {
            this._showStatus('Нужно минимум 2 точки', 'error');
            return;
        }

        this.pv.clear();

        const pts    = this.waypoints;
        const smooth = pts.length >= 3 ? bezierSpline(pts, 24) : pts;
        this.pv.drawPath(smooth);

        this.phase = 'navigating';
        this.ar.reticle.visible = false;
        this.fp.clear();

        this.$btnAdd.disabled   = true;
        this.$btnRoute.disabled = true;
        this.$stepText.textContent = '🧭 Следуй по маршруту!';
        this._showStatus(`Маршрут построен через ${this.waypoints.length} точек`, 'success');
    }

    private _reset(): void {
        for (const g of this.markers) this._disposeGroup(g);
        this.markers   = [];
        this.waypoints = [];

        this.pv.clear();
        this.fp.clear();

        if (this.phase === 'navigating') this.phase = 'placing';
        this._updateUI();
        this._showStatus('Сброс выполнен', 'info');
    }

    // ── UI helpers ────────────────────────────────────────────────────────────

    private _updateUI(): void {
        const n = this.waypoints.length;

        // Pluralisation for «точка»
        const label = n === 1 ? '1 точка' : n >= 2 && n <= 4 ? `${n} точки` : `${n} точек`;
        this.$wpCount.textContent = label;

        this.$wpDots.innerHTML = '';
        this.waypoints.forEach((_, i) => {
            const d = document.createElement('div');
            const cls = i === 0 ? 'start' : i === this.waypoints.length - 1 ? 'end' : 'mid';
            d.className = `wp-dot ${cls}`;
            this.$wpDots.appendChild(d);
        });

        this.$btnAdd.disabled   = false;
        this.$btnRoute.disabled = n < 2;

        this.$stepText.textContent = n === 0
            ? 'Направь камеру на пол и нажми «Добавить»'
            : n === 1
                ? 'Добавь ещё точку, чтобы построить маршрут'
                : `${n} точек — нажми «Маршрут» или добавь ещё`;
    }

    private _showStatus(msg: string, type: 'info' | 'success' | 'error'): void {
        const icons = { info: 'ℹ️', success: '✅', error: '❌' };
        this.$status.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
        this.$status.className = `on ${type}`;
    }

    // ── Hit-test setup ────────────────────────────────────────────────────────

    private async _setupHitTest(session: XRSession): Promise<void> {
        try {
            this.viewerSpace  = await session.requestReferenceSpace('viewer');
            this.refSpace     = await session.requestReferenceSpace('local');
            this.hitTestSource = (await session.requestHitTestSource!({ space: this.viewerSpace })) ?? null;
        } catch (e) {
            console.error('[AR] hit-test setup failed:', e);
        }
    }

    // ── 3-D marker ────────────────────────────────────────────────────────────

    private _makeMarker(pos: THREE.Vector3, color: number, label: string): THREE.Group {
        const g = new THREE.Group();

        // Sphere
        const sphere = new THREE.Mesh(
            new THREE.SphereGeometry(0.05, 16, 16),
            new THREE.MeshBasicMaterial({ color })
        );
        sphere.position.y = 0.05;
        g.add(sphere);

        // Ground ring
        const rGeo = new THREE.RingGeometry(0.06, 0.09, 32);
        rGeo.rotateX(-Math.PI / 2);
        g.add(new THREE.Mesh(rGeo, new THREE.MeshBasicMaterial({
            color, transparent: true, opacity: 0.35,
            side: THREE.DoubleSide, depthWrite: false,
        })));

        // Number label sprite
        const canvas    = document.createElement('canvas');
        canvas.width    = canvas.height = 128;
        const ctx       = canvas.getContext('2d')!;
        ctx.fillStyle   = '#' + color.toString(16).padStart(6, '0');
        ctx.beginPath(); ctx.arc(64, 64, 56, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle   = '#000';
        ctx.font        = 'bold 62px Inter,sans-serif';
        ctx.textAlign   = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, 64, 68);
        const spr = new THREE.Sprite(new THREE.SpriteMaterial({
            map: new THREE.CanvasTexture(canvas), depthWrite: false,
        }));
        spr.scale.set(0.14, 0.14, 1);
        spr.position.y = 0.20;
        g.add(spr);

        g.position.copy(pos);
        this.ar.scene.add(g);
        return g;
    }

    private _disposeGroup(g: THREE.Group): void {
        this.ar.scene.remove(g);
        g.traverse(c => {
            if (c instanceof THREE.Mesh || c instanceof THREE.Sprite) {
                (c as THREE.Mesh).geometry?.dispose();
                const mat = (c as THREE.Mesh).material;
                if (Array.isArray(mat)) mat.forEach(m => m.dispose());
                else (mat as THREE.Material)?.dispose();
            }
        });
    }

    dispose(): void { this.ar.dispose(); this.fp.dispose(); this.pv.dispose(); }
}

window.addEventListener('DOMContentLoaded', () => {
    (window as unknown as Record<string, unknown>)['arNav'] = new ARNavigator();
});
