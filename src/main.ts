import * as THREE from 'three';
import { WebARSession } from './core/WebARSession';
import { FeaturePoints } from './ar/FeaturePoints';
import { PlaneDetection } from './ar/PlaneDetection';
import { PathVisualizer } from './ar/PathVisualizer';
import { UIManager } from './ui/UIManager';
import { bezierSpline } from './utils/BezierSpline';

// ── Constants ────────────────────────────────────────────────────────────────
const HIT_MIN_DIST = 0.15; // м — фильтр «на себя»
const FLOOR_MIN_Y = 0.25; // sin нормали → горизонтальная поверхность

// Цвета маркеров
const COLOR_START = 0x00ff88;
const COLOR_MID = 0x4488ff;
const COLOR_END = 0xff8800;

// ────────────────────────────────────────────────────────────────────────────

class ARNavigator {
    private readonly ar: WebARSession;
    private readonly fp: FeaturePoints;
    private readonly pd: PlaneDetection;
    private readonly pv: PathVisualizer;
    private readonly ui: UIManager;

    // Hit-test
    private hitTestSource: XRHitTestSource | null = null;
    private refSpace: XRReferenceSpace | null = null;
    private viewerSpace: XRReferenceSpace | null = null;
    private sessionReady = false;

    // Мульти-вейпоинты
    private waypoints: THREE.Vector3[] = [];
    private markers: THREE.Group[] = [];
    private routeBuilt = false;

    constructor() {
        const container = document.getElementById('ar-container')!;
        this.ar = new WebARSession(container);
        this.fp = new FeaturePoints(this.ar.scene);
        this.pd = new PlaneDetection();
        this.pv = new PathVisualizer(this.ar.scene);
        this.ui = new UIManager();

        this._bindEvents();
        this._init();
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    private async _init(): Promise<void> {
        const arOk = await this.ar.initializeAR();
        if (arOk) {
            this.ui.showStatus('AR поддерживается — нажмите «Запустить AR»', 'success');
        } else {
            this.ui.showStatus('WebXR AR недоступен. Нужен Chrome на Android.', 'error');
        }
        this.ui.hideLoading();
        this.ui.updateWaypoints(0);

        this.ar.animate((time, frame) => this._onFrame(time, frame));
    }

    // ── Events ────────────────────────────────────────────────────────────────

    private _bindEvents(): void {
        window.addEventListener('ar:enter', () => this.ar.triggerAREntry());
        window.addEventListener('ar:addwp', () => this._addWaypoint());
        window.addEventListener('ar:buildroute', () => this._buildRoute());
        window.addEventListener('ar:reset', () => this._reset());
    }

    // ── Frame Loop ────────────────────────────────────────────────────────────

    private _onFrame(time: number, frame: XRFrame | undefined): void {
        // Синхронизация AR-стейта
        const wasActive = this.ui['$badge']?.classList.contains('on');
        if (this.ar.isARActive && !wasActive) this.ui.setARActive(true);
        if (!this.ar.isARActive && wasActive) {
            this.ui.setARActive(false);
            this.sessionReady = false;
            this.hitTestSource = null;
            this.refSpace = null;
        }

        // Feature-points fade каждый кадр
        this.fp.update(time);

        if (!frame || !this.ar.isARActive) return;

        // Если маршрут построен — не обновляем ретикл и точки
        if (this.routeBuilt) return;

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

        const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
        const pos = new THREE.Vector3().setFromMatrixPosition(m);
        const normal = new THREE.Vector3(m.elements[4], m.elements[5], m.elements[6]).normalize();

        // Фильтр «навёл на себя»
        const camPos = new THREE.Vector3().setFromMatrixPosition(this.ar.camera.matrixWorld);
        if (pos.distanceTo(camPos) < HIT_MIN_DIST) {
            this.ar.reticle.visible = false;
            this.fp.clear();
            return;
        }

        // Ретикл
        this.ar.reticle.visible = true;
        this.ar.reticle.position.copy(pos);
        // Ориентируем ретикл по нормали
        const up = new THREE.Vector3(0, 1, 0);
        const quat = new THREE.Quaternion().setFromUnitVectors(up, normal);
        this.ar.reticle.setRotationFromQuaternion(quat);

        // Feature-points: обновляем положение белого кольца точек
        this.fp.updatePose(pos, quat, time);

        // Пульсация зеленого прицела
        const pulse = 1.0 + 0.08 * Math.sin(time / 150);
        this.ar.reticle.scale.setScalar(pulse);

        this.pd.update(pos, normal);
    }

    private async _setupHitTest(session: XRSession): Promise<void> {
        try {
            this.viewerSpace = await session.requestReferenceSpace('viewer');
            this.refSpace = await session.requestReferenceSpace('local');
            this.hitTestSource = (await session.requestHitTestSource!({ space: this.viewerSpace })) ?? null;
        } catch (e) {
            console.error('[AR] hit-test failed:', e);
            this.ui.showStatus('Hit-test недоступен', 'error');
        }
    }

    // ── Add Waypoint ──────────────────────────────────────────────────────────

    private _addWaypoint(): void {
        if (!this.ar.reticle.visible) {
            this.ui.showStatus('Наведи камеру на поверхность', 'error');
            return;
        }

        if (this.routeBuilt) {
            this.ui.showStatus('Сначала сброс (↺)', 'info');
            return;
        }

        const pos = this.ar.reticle.position.clone();
        const index = this.waypoints.length;
        this.waypoints.push(pos);

        // Цвет маркера: старт → зелёный, остальные → синий (финиш обновится при построении маршрута)
        const color = index === 0 ? COLOR_START : COLOR_MID;
        const marker = this._makeMarker(pos, color, index + 1);
        this.markers.push(marker);

        this.ui.updateWaypoints(this.waypoints.length);

        const label = index === 0 ? 'Стартовая точка' : `Точка ${index + 1}`;
        this.ui.showStatus(`${label} добавлена!`, 'success');
    }

    // ── Build Route ───────────────────────────────────────────────────────────

    private _buildRoute(): void {
        if (this.waypoints.length < 2) {
            this.ui.showStatus('Нужно минимум 2 точки', 'error');
            return;
        }

        // Перекрашиваем последний маркер в цвет финиша
        const lastMarker = this.markers[this.markers.length - 1];
        lastMarker.traverse(c => {
            if (c instanceof THREE.Mesh && c.material instanceof THREE.MeshBasicMaterial) {
                c.material.color.setHex(COLOR_END);
            }
        });

        // Bezier сплайн через все точки (от первой к последней)
        const ordered = [...this.waypoints]; // waypoints[0] = старт всегда
        const splinePoints = bezierSpline(ordered, 28);
        this.pv.drawPath(splinePoints);

        // Скрываем ретикл и точки
        this.ar.reticle.visible = false;
        this.fp.clear();

        this.routeBuilt = true;
        this.ui.setRouteBuilt();
        this.ui.showStatus(
            `Маршрут построен через ${this.waypoints.length} точки!`,
            'success'
        );
    }

    // ── Reset ─────────────────────────────────────────────────────────────────

    private _reset(): void {
        this.waypoints = [];
        this.routeBuilt = false;

        for (const m of this.markers) this._disposeGroup(m);
        this.markers = [];

        this.pv.clear();
        this.fp.clear();
        this.pd.clear();

        this.ui.updateWaypoints(0);
        this.ui.showStatus('Сброшено', 'info');

        if (this.ar.isARActive) this.ui.setARActive(true);
    }

    // ── Marker helpers ────────────────────────────────────────────────────────

    private _makeMarker(pos: THREE.Vector3, color: number, num: number): THREE.Group {
        const g = new THREE.Group();

        // Сфера
        const sphere = new THREE.Mesh(
            new THREE.SphereGeometry(0.045, 16, 16),
            new THREE.MeshBasicMaterial({ color })
        );
        sphere.position.y = 0.045;
        g.add(sphere);

        // Кольцо на полу
        const ringGeo = new THREE.RingGeometry(0.055, 0.085, 32);
        ringGeo.rotateX(-Math.PI / 2);
        const ring = new THREE.Mesh(
            ringGeo,
            new THREE.MeshBasicMaterial({
                color, transparent: true, opacity: 0.4,
                side: THREE.DoubleSide, depthWrite: false
            })
        );
        g.add(ring);

        // Номер точки (sprite через canvas)
        const label = this._makeLabel(String(num), color);
        label.position.y = 0.13;
        g.add(label);

        g.position.copy(pos);
        this.ar.scene.add(g);
        return g;
    }

    private _makeLabel(text: string, color: number): THREE.Sprite {
        const size = 128;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d')!;

        const hex = '#' + color.toString(16).padStart(6, '0');
        ctx.fillStyle = hex;
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#000';
        ctx.font = `bold ${size * 0.45}px Inter, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, size / 2, size / 2);

        const tex = new THREE.CanvasTexture(canvas);
        const mat = new THREE.SpriteMaterial({ map: tex, depthWrite: false });
        const spr = new THREE.Sprite(mat);
        spr.scale.setScalar(0.07);
        return spr;
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

    dispose(): void {
        this.ar.dispose();
        this.fp.dispose();
        this.pd.dispose();
        this.pv.dispose();
    }
}

window.addEventListener('DOMContentLoaded', () => {
    (window as unknown as Record<string, unknown>)['arNav'] = new ARNavigator();
});
