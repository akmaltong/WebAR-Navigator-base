import * as THREE from 'three';
import { WebARSession } from './core/WebARSession';
import { FeaturePoints } from './ar/FeaturePoints';
import { PlaneDetection } from './ar/PlaneDetection';
import { PathVisualizer } from './ar/PathVisualizer';
import { AprilTagTracker } from './ar/AprilTagTracker';
import { GeometryViewer } from './core/GeometryViewer';
import { GizmoController, GizmoMode } from './core/GizmoController';
import { UIManager } from './ui/UIManager';
import { bezierSpline } from './utils/BezierSpline';

// ── Constants ────────────────────────────────────────────────────────────────
const HIT_MIN_DIST = 0.10; // м — фильтр «слишком близко» (на себя)
const HIT_MAX_DIST = 8.0;  // м — фильтр «слишком далеко» (шум)

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
    private readonly gv: GeometryViewer;
    private readonly ui: UIManager;
    private gc: GizmoController | null = null;

    // Hit-test
    private hitTestSource: XRHitTestSource | null = null;
    private refSpace: XRReferenceSpace | null = null;
    private viewerSpace: XRReferenceSpace | null = null;
    private sessionReady = false;

    // Мульти-вейпоинты
    private waypoints: THREE.Vector3[] = [];
    private markers: THREE.Group[] = [];
    private routeBuilt = false;
    private geoLoaded = false;

    // AprilTag Sync
    private tagTracker: AprilTagTracker;
    private scannedTags: Map<number, THREE.Vector3> = new Map();
    private trackingFinished = false;
    private TARGET_TAG_IDS = [0, 1];
    private TAG_0_BLENDER = new THREE.Vector3(-2.5, 0, -5.5); // метка 0 (AprilTag)
    private TAG_1_BLENDER = new THREE.Vector3(-2.5, 0, 2.5);  // метка 1 (AprilTag.001)

    constructor() {
        const container = document.getElementById('ar-container')!;
        this.ar = new WebARSession(container);
        this.fp = new FeaturePoints(this.ar.scene);
        this.pd = new PlaneDetection();
        this.pv = new PathVisualizer(this.ar.scene);
        this.gv = new GeometryViewer(this.ar.scene);
        this.ui = new UIManager();
        this.tagTracker = new AprilTagTracker();
        this.tagTracker.onTagDetected = (id, pos) => this._onTagDetected(id, pos);

        this._bindEvents();
        this._bindEditorUI();
        this._init();
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    private async _init(): Promise<void> {
        await this.tagTracker.init();
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
        window.addEventListener('ar:enter', () => {
            this.ar.triggerAREntry();
            // Показываем UI сканирования меток
            document.getElementById('tag-sync-ui')!.style.display = 'flex';
        });

        // Насильная установка (пропуск сканирования)
        document.getElementById('btn-place-geo')?.addEventListener('click', () => {
            if (!this.geoLoaded && this.ar.reticle.visible) {
                this.trackingFinished = true;
                this.geoLoaded = true;
                this._loadGeometry(this.ar.reticle.position.clone());
            }
        });

        // Синхронизация по отсканированным меткам
        document.getElementById('btn-sync-tags')?.addEventListener('click', () => {
            if (!this.geoLoaded && !this.trackingFinished) {
                this._alignGeometryWithTags();
            }
        });

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

        // Gizmo update
        this.gc?.update(time);

        // Очистка устаревших плоскостей
        this.pd.tick();

        if (!frame || !this.ar.isARActive) return;

        // Показываем UI для позиционирования геометрии, если она еще не поставлена
        const syncUi = document.getElementById('tag-sync-ui');
        if (syncUi && !this.geoLoaded) {
            syncUi.style.display = 'flex';
        }

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

        // Фильтр по дистанции
        const camPos = new THREE.Vector3().setFromMatrixPosition(this.ar.camera.matrixWorld);
        const dist = pos.distanceTo(camPos);
        if (dist < HIT_MIN_DIST || dist > HIT_MAX_DIST) {
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

        // Показываем кнопку постановки геометрии если она еще не поставлена
        const btnPlace = document.getElementById('btn-place-geo');
        if (btnPlace && !this.geoLoaded) {
            btnPlace.style.display = 'block';
        }
    }

    private async _setupHitTest(session: XRSession): Promise<void> {
        try {
            this.viewerSpace = await session.requestReferenceSpace('viewer');

            // IMPORTANT: Use the same reference space as the Three.js XR renderer
            // so hit-test positions match the scene coordinate system.
            // Three.js uses 'local-floor' when available (origin at floor level),
            // but requesting 'local' separately (origin at device height) caused
            // a ~1.5m Y offset → objects "flew away" when rotating the camera.
            this.refSpace = this.ar.renderer.xr.getReferenceSpace();
            if (!this.refSpace) {
                // Fallback: match what Three.js would choose
                try {
                    this.refSpace = await session.requestReferenceSpace('local-floor');
                } catch {
                    this.refSpace = await session.requestReferenceSpace('local');
                }
            }

            this.hitTestSource = (await session.requestHitTestSource!({
                space: this.viewerSpace,
                entityTypes: ['plane'] as any   // Только planes, 'point' часто крашит AR сессию в новых версиях Chrome
            })) ?? null;
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
        const stablePlanes = this.pd.getStablePlanes();
        const surfaceInfo = stablePlanes.length > 0
            ? ` (${this.pd.floorCount()} пол, ${this.pd.wallCount()} стен)`
            : '';
        this.ui.showStatus(`${label} добавлена!${surfaceInfo}`, 'success');
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
        this.gv.dispose();
        this.gc?.dispose();
    }

    // ── Geometry & AprilTag Align ────────────────────────────────────────────

    private _onTagDetected(id: number, pos: THREE.Vector3): void {
        if (!this.TARGET_TAG_IDS.includes(id)) return;

        if (!this.scannedTags.has(id)) {
            this.scannedTags.set(id, pos.clone());
        } else {
            this.scannedTags.get(id)!.lerp(pos, 0.2); // Сглаживание маркеров
        }

        const foundCount = this.scannedTags.size;
        const statusEl = document.getElementById('tag-status');
        if (statusEl) {
            statusEl.textContent = `📷 Выявлено меток (${foundCount}/${this.TARGET_TAG_IDS.length})...`;
            if (foundCount >= this.TARGET_TAG_IDS.length) {
                statusEl.textContent = `✅ Все метки найдены!`;
                statusEl.style.color = '#fff';
                statusEl.style.background = 'var(--green)';

                const syncBtn = document.getElementById('btn-sync-tags') as HTMLButtonElement;
                if (syncBtn && syncBtn.disabled) {
                    syncBtn.disabled = false;
                    syncBtn.style.opacity = '1';
                }
            }
        }
    }

    private _alignGeometryWithTags(): void {
        if (!this.scannedTags.has(this.TARGET_TAG_IDS[0]) || !this.scannedTags.has(this.TARGET_TAG_IDS[1])) return;

        const w0 = this.scannedTags.get(this.TARGET_TAG_IDS[0])!;
        const w1 = this.scannedTags.get(this.TARGET_TAG_IDS[1])!;

        const vecW = new THREE.Vector3().subVectors(w1, w0);
        const vecB = new THREE.Vector3().subVectors(this.TAG_1_BLENDER, this.TAG_0_BLENDER);

        // 1. Масштаб
        const scale = vecW.length() / vecB.length();

        // 2. Вращение по оси Y
        const angleW = Math.atan2(vecW.x, vecW.z);
        const angleB = Math.atan2(vecB.x, vecB.z);
        const rotY = angleW - angleB;

        // 3. Перенос: Матрица = Трансляция(0) * Вращение(Y) * Масштаб(S)
        const dummy = new THREE.Object3D();
        dummy.position.set(0, 0, 0);
        dummy.rotation.y = rotY;
        dummy.scale.set(scale, scale, scale);
        dummy.updateMatrix();

        const b0_computed = this.TAG_0_BLENDER.clone();
        b0_computed.applyMatrix4(dummy.matrix);

        const finalPos = new THREE.Vector3().subVectors(w0, b0_computed);

        this.trackingFinished = true;
        this.geoLoaded = true;

        this._loadGeometry(finalPos, rotY, scale);
    }

    private async _loadGeometry(pos: THREE.Vector3, rotY: number = 0, scale: number = 1): Promise<void> {
        // Скрываем кнопку постановки геометрии
        const btnPlace = document.getElementById('btn-place-geo');
        const tagUi = document.getElementById('tag-sync-ui');
        if (btnPlace) btnPlace.style.display = 'none';
        if (tagUi) tagUi.style.display = 'none';

        this.ui.showStatus('Загрузка геометрии…', 'info');
        try {
            await this.gv.load('/Navmesh.glb', '/SM_Room.glb', '/Points.glb');

            // Устанавливаем в позицию ретикла / метки
            this.gv.setPosition(pos.x, pos.y, pos.z);
            if (rotY !== 0) {
                this.gv.root.rotation.set(0, rotY, 0);
                const sRot = document.getElementById('slider-rotation') as HTMLInputElement;
                if (sRot) sRot.value = (rotY * THREE.MathUtils.RAD2DEG).toString();
            }
            if (scale !== 1) {
                this.gv.setScale(scale);
                const sScale = document.getElementById('slider-scale') as HTMLInputElement;
                if (sScale) sScale.value = scale.toString();
            }

            // Показываем панель геометрии и табов
            document.getElementById('main-panel')?.style.setProperty('display', 'flex');
            document.getElementById('mode-tabs')?.style.setProperty('display', 'flex');

            // Создаём гизмо-контроллер
            const touchEl = document.getElementById('gizmo-touch')!;
            this.gc = new GizmoController(
                this.ar.scene,
                this.ar.camera,
                this.gv.root,
                touchEl
            );
            this.gc.mode = 'translate';
            this.gc.show();
            touchEl.classList.add('active');

            this.ui.showStatus('Геометрия загружена! Двигай модель', 'success');
        } catch (e) {
            console.error('[ARNavigator] Failed to load geometry:', e);
            this.ui.showStatus('Ошибка загрузки геометрии', 'error');
        }
    }

    // ── Unified Editor UI Binding ─────────────────────────────────────────────

    private _bindEditorUI(): void {
        const tabs = document.querySelectorAll('.mode-tab');
        const contents = document.querySelectorAll('.tab-content');
        const touchOverlay = document.getElementById('gizmo-touch')!;

        // Tab switching
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => t.classList.remove('active'));
                contents.forEach(c => c.classList.remove('active'));

                tab.classList.add('active');
                const target = (tab as HTMLElement).dataset.tab;
                document.getElementById(`tab-${target}`)?.classList.add('active');

                // Toggle gizmo touch layer based on target
                if (target === 'edit' && this.gc?.mode !== 'off') {
                    this.gc?.show();
                    touchOverlay.classList.add('active');
                } else {
                    this.gc?.hide();
                    touchOverlay.classList.remove('active');
                }
            });
        });

        // Layer chips
        document.querySelectorAll('.layer-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const layer = (chip as HTMLElement).dataset.layer as 'navmesh' | 'walls' | 'points';
                const isOn = this.gv.toggleLayer(layer);
                chip.classList.toggle('on', isOn);
            });
        });

        // Gizmo mode buttons
        document.querySelectorAll('.gm-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = (btn as HTMLElement).dataset.mode as GizmoMode;
                document.querySelectorAll('.gm-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                if (this.gc) {
                    this.gc.mode = mode;
                    if (mode === 'off') {
                        this.gc.hide();
                        touchOverlay.classList.remove('active');
                    } else {
                        this.gc.show();
                        touchOverlay.classList.add('active');
                    }
                }
            });
        });

        // Scale & Rotation sliders
        const scaleSlider = document.getElementById('geo-scale') as HTMLInputElement;
        const scaleVal = document.getElementById('geo-scale-val')!;
        scaleSlider?.addEventListener('input', () => {
            const s = parseFloat(scaleSlider.value);
            this.gv.setScale(s);
            scaleVal.textContent = s.toFixed(2);
        });

        const rotSlider = document.getElementById('geo-rot') as HTMLInputElement;
        const rotVal = document.getElementById('geo-rot-val')!;
        rotSlider?.addEventListener('input', () => {
            const deg = parseFloat(rotSlider.value);
            this.gv.setRotationY(deg);
            rotVal.textContent = `${deg}°`;
        });

        // Y-height buttons
        const Y_STEP = 0.03;
        document.getElementById('gizmo-y-up')?.addEventListener('click', () => {
            if (this.gv) {
                this.gv.translate(0, Y_STEP, 0);
                this._updatePosInfo();
            }
        });
        document.getElementById('gizmo-y-down')?.addEventListener('click', () => {
            if (this.gv) {
                this.gv.translate(0, -Y_STEP, 0);
                this._updatePosInfo();
            }
        });

        // Reset
        document.getElementById('geo-pos-reset')?.addEventListener('click', () => {
            if (!this.gv) return;
            this.gv.setPosition(0, 0, 0);
            this.gv.setScale(1);
            this.gv.setRotationY(0);
            if (scaleSlider) scaleSlider.value = '1';
            if (scaleVal) scaleVal.textContent = '1.00';
            if (rotSlider) rotSlider.value = '0';
            if (rotVal) rotVal.textContent = '0°';
            this._updatePosInfo();
        });

        // Save
        document.getElementById('btn-save-geo')?.addEventListener('click', () => {
            if (!this.gv) return;
            const p = this.gv.getPosition();
            const r = this.gv.getRotationY();
            const s = this.gv.getScale();
            console.log(`[Geometry] Saved: pos(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}), rotY(${r.toFixed(1)}°), scale(${s.toFixed(2)})`);
            this.ui.showStatus('Успешно сохранено!', 'success');
        });
    }

    private _updatePosInfo(): void {
        if (!this.gv) return;
        const p = this.gv.getPosition();
        const info = document.getElementById('geo-pos-info');
        if (info) {
            info.textContent = `pos: ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`;
        }
    }
}

window.addEventListener('DOMContentLoaded', () => {
    (window as unknown as Record<string, unknown>)['arNav'] = new ARNavigator();
});
