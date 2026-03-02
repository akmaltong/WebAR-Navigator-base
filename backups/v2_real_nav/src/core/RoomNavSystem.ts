import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
// @ts-ignore
import { NavMesh, Polygon, Vector3 as YukaVector3 } from 'yuka';

export interface ZonePoint {
    id: string;
    label: string;
    position: THREE.Vector3;
    snappedPosition: THREE.Vector3;
}

const ZONE_LABELS: Record<string, string> = {
    'PC': '💻 Компьютер',
    'Bed': '🛏️ Спальня',
    'Kitchen': '🍳 Кухня',
    'bathroom': '🚿 Ванная',
    'In': '🚪 Вход',
    'koridor': '🏠 Коридор',
};

const STORAGE_KEY_ANGLE = 'arNav_calibAngle';
const STORAGE_KEY_OX = 'arNav_calibOffsetX';
const STORAGE_KEY_OY = 'arNav_calibOffsetY';
const STORAGE_KEY_OZ = 'arNav_calibOffsetZ';
const STORAGE_KEY_SCALE = 'arNav_calibScale';

export class RoomNavSystem {
    public zones: ZonePoint[] = [];
    public navMesh: any = null;
    public navMeshReady = false;
    public zonesReady = false;
    public calibrated = false;

    // The room model mesh (for visual alignment)
    public roomMesh: THREE.Group | null = null;
    public navMeshVisual: THREE.Mesh | null = null;
    public zoneMarkers: THREE.Group | null = null;

    // Calibration params
    public rotationY = 0;        // radians
    public offsetX = 0;          // meters - shift in AR space
    public offsetY = 0;          // meters - shift in AR space (height)
    public offsetZ = 0;          // meters - shift in AR space
    public scale = 1.0;
    private anchorZoneId = '';
    private anchorARPos = new THREE.Vector3();

    // Transform: model → AR
    private originMatrix = new THREE.Matrix4();
    private invOriginMatrix = new THREE.Matrix4();

    private loader = new GLTFLoader();

    constructor() {
        // Load saved calibration from localStorage
        const sa = localStorage.getItem(STORAGE_KEY_ANGLE);
        if (sa) this.rotationY = parseFloat(sa);
        const sox = localStorage.getItem(STORAGE_KEY_OX);
        if (sox) this.offsetX = parseFloat(sox);
        const soy = localStorage.getItem(STORAGE_KEY_OY);
        if (soy) this.offsetY = parseFloat(soy);
        const soz = localStorage.getItem(STORAGE_KEY_OZ);
        if (soz) this.offsetZ = parseFloat(soz);
        const ss = localStorage.getItem(STORAGE_KEY_SCALE);
        if (ss) this.scale = parseFloat(ss);
        console.log(`[Calib] Loaded: angle=${(this.rotationY * 180 / Math.PI).toFixed(1)}° oX=${this.offsetX.toFixed(2)} oY=${this.offsetY.toFixed(2)} oZ=${this.offsetZ.toFixed(2)} scale=${this.scale.toFixed(2)}`);
    }

    // ── Load Points.glb ──────────────────────────────────────────────────────

    async loadZones(url: string): Promise<ZonePoint[]> {
        return new Promise((resolve, reject) => {
            this.loader.load(url, (gltf) => {
                this.zones = [];
                gltf.scene.traverse((child) => {
                    const name = child.name;
                    if (!name || name === 'Scene') return;
                    if (!(child instanceof THREE.Mesh) && child.type !== 'Object3D') return;

                    child.updateMatrixWorld(true);
                    const pos = new THREE.Vector3();
                    child.getWorldPosition(pos);

                    this.zones.push({
                        id: name,
                        label: ZONE_LABELS[name] || name,
                        position: pos.clone(),
                        snappedPosition: pos.clone(),
                    });
                    console.log(`[Zone] "${name}" at (${pos.x.toFixed(3)}, ${pos.y.toFixed(3)}, ${pos.z.toFixed(3)})`);
                });

                this.zonesReady = true;
                console.log(`✅ ${this.zones.length} zones loaded`);
                resolve(this.zones);
            }, undefined, reject);
        });
    }

    // ── Load Navmesh.glb ─────────────────────────────────────────────────────

    async loadNavMesh(url: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.loader.load(url, (gltf) => {
                let foundMesh: THREE.Mesh | undefined;
                gltf.scene.traverse((child) => {
                    if (!foundMesh && child instanceof THREE.Mesh) foundMesh = child;
                });

                if (!foundMesh) { reject(new Error('No mesh')); return; }

                foundMesh.updateMatrixWorld(true);
                const geometry = foundMesh.geometry.clone();
                geometry.applyMatrix4(foundMesh.matrixWorld);

                // Save visual representation 
                this.navMeshVisual = new THREE.Mesh(
                    geometry.clone(),
                    new THREE.MeshBasicMaterial({
                        color: 0x00ff88,
                        transparent: true,
                        opacity: 0.15,
                        side: THREE.DoubleSide,
                        depthWrite: false,
                        wireframe: false,
                    })
                );

                // Wireframe overlay
                const wire = new THREE.Mesh(
                    geometry.clone(),
                    new THREE.MeshBasicMaterial({
                        color: 0x00ff88,
                        transparent: true,
                        opacity: 0.4,
                        wireframe: true,
                    })
                );
                this.navMeshVisual.add(wire);

                try {
                    const polygons = this._parseGeometry(geometry);
                    this.navMesh = new NavMesh();
                    this.navMesh.fromPolygons(polygons);
                    this.navMeshReady = true;

                    this._snapZonesToNavMesh();

                    console.log(`✅ NavMesh: ${this.navMesh.regions.length} regions`);
                    resolve();
                } catch (err) {
                    console.error('❌ NavMesh build failed:', err);
                    reject(err);
                }
            }, undefined, reject);
        });
    }

    // ── Load SM_Room.glb (walls visual) ──────────────────────────────────────

    async loadRoomModel(url: string): Promise<THREE.Group> {
        return new Promise((resolve, reject) => {
            this.loader.load(url, (gltf) => {
                const group = gltf.scene;
                group.traverse((child) => {
                    if (child instanceof THREE.Mesh) {
                        child.material = new THREE.MeshBasicMaterial({
                            color: 0x4488ff,
                            transparent: true,
                            opacity: 0.2,
                            side: THREE.DoubleSide,
                            depthWrite: false,
                        });
                        // Also add wireframe
                        const wireMat = new THREE.MeshBasicMaterial({
                            color: 0x4488ff,
                            transparent: true,
                            opacity: 0.5,
                            wireframe: true,
                        });
                        const wireMesh = new THREE.Mesh(child.geometry.clone(), wireMat);
                        child.add(wireMesh);
                    }
                });
                this.roomMesh = group;
                console.log('✅ Room model loaded');
                resolve(group);
            }, undefined, reject);
        });
    }

    // ── Create zone marker visuals ───────────────────────────────────────────

    createZoneMarkerGroup(): THREE.Group {
        const group = new THREE.Group();
        for (const zone of this.zones) {
            // Small colored sphere at zone position
            const sphere = new THREE.Mesh(
                new THREE.SphereGeometry(0.08, 12, 12),
                new THREE.MeshBasicMaterial({ color: 0xffff00, transparent: true, opacity: 0.7 })
            );
            sphere.position.copy(zone.snappedPosition);
            sphere.position.y += 0.08;
            group.add(sphere);

            // Label
            const label = this._makeLabelSprite(zone.label, 0xffff00);
            label.position.copy(zone.snappedPosition);
            label.position.y += 0.25;
            group.add(label);
        }
        this.zoneMarkers = group;
        return group;
    }

    // ── Snap zones to navmesh ────────────────────────────────────────────────

    private _snapZonesToNavMesh(): void {
        if (!this.navMeshReady) return;
        for (const zone of this.zones) {
            const snapped = this._clampToNavMesh(zone.position);
            zone.snappedPosition = snapped;
        }
    }

    private _clampToNavMesh(point: THREE.Vector3): THREE.Vector3 {
        if (!this.navMesh?.regions?.length) return point.clone();
        const yp = new YukaVector3(point.x, point.y, point.z);
        const region = this.navMesh.getClosestRegion(yp);
        if (!region) return point.clone();
        return new THREE.Vector3(point.x, region.centroid.y, point.z);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  CALIBRATION
    // ══════════════════════════════════════════════════════════════════════════

    /** Adjust rotation by delta (radians) */
    adjustRotation(deltaRad: number): void {
        this.rotationY += deltaRad;
        // Normalize to [-PI, PI]
        while (this.rotationY > Math.PI) this.rotationY -= 2 * Math.PI;
        while (this.rotationY < -Math.PI) this.rotationY += 2 * Math.PI;
        this._rebuildTransform();
    }

    /** Set rotation absolutely */
    setRotation(rad: number): void {
        this.rotationY = rad;
        this._rebuildTransform();
    }

    /** Adjust offset by delta (meters) in AR space */
    adjustOffset(dx: number, dy: number, dz: number): void {
        this.offsetX += dx;
        this.offsetY += dy;
        this.offsetZ += dz;
        this._rebuildTransform();
    }

    /** Adjust scale by multiplier */
    adjustScale(delta: number): void {
        this.scale = Math.max(0.1, this.scale + delta);
        this._rebuildTransform();
    }

    /** Save calibration to localStorage */
    saveCalibration(): void {
        localStorage.setItem(STORAGE_KEY_ANGLE, this.rotationY.toString());
        localStorage.setItem(STORAGE_KEY_OX, this.offsetX.toString());
        localStorage.setItem(STORAGE_KEY_OY, this.offsetY.toString());
        localStorage.setItem(STORAGE_KEY_OZ, this.offsetZ.toString());
        localStorage.setItem(STORAGE_KEY_SCALE, this.scale.toString());
        console.log(`💾 Saved: angle=${(this.rotationY * 180 / Math.PI).toFixed(1)}° oX=${this.offsetX.toFixed(2)} oY=${this.offsetY.toFixed(2)} oZ=${this.offsetZ.toFixed(2)} scale=${this.scale.toFixed(2)}`);
    }

    /** Two-point calibration: automatically calculates scale and rotation, and anchors to point A */
    calibrateTwoPoints(pA_id: string, pA_ar: THREE.Vector3, pB_id: string, pB_ar: THREE.Vector3): void {
        const zA = this.getZone(pA_id);
        const zB = this.getZone(pB_id);
        if (!zA || !zB) return;

        const mA = zA.snappedPosition;
        const mB = zB.snappedPosition;

        // Auto-scale
        const distAR = Math.hypot(pB_ar.x - pA_ar.x, pB_ar.z - pA_ar.z);
        const distM = Math.hypot(mB.x - mA.x, mB.z - mA.z);
        if (distM > 0.01 && distAR > 0.01) {
            this.scale = distAR / distM;
        }

        // Auto-rotation (around Y)
        const d_ar = new THREE.Vector3().subVectors(pB_ar, pA_ar);
        const d_m = new THREE.Vector3().subVectors(mB, mA);

        const angleAR = Math.atan2(d_ar.x, d_ar.z);
        const angleM = Math.atan2(d_m.x, d_m.z);
        this.rotationY = angleAR - angleM;

        // Reset offsets since anchor A takes care of position
        this.offsetX = 0;
        this.offsetY = 0;
        this.offsetZ = 0;

        // Make A the anchor
        this.setAnchor(pA_id, pA_ar);
    }

    /** Set anchor: which zone + AR position is the reference point */
    setAnchor(zoneId: string, arPos: THREE.Vector3): void {
        this.anchorZoneId = zoneId;
        this.anchorARPos.copy(arPos);
        this._rebuildTransform();
        this.calibrated = true;
    }

    /** Rebuild transform matrix from current rotation + anchor */
    private _rebuildTransform(): void {
        const zone = this.zones.find(z => z.id === this.anchorZoneId);
        if (!zone) return;

        const modelA = zone.snappedPosition;

        const quat = new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0), this.rotationY
        );
        const scaleVec = new THREE.Vector3(this.scale, 1, this.scale);

        const toOrigin = new THREE.Matrix4().makeTranslation(-modelA.x, -modelA.y, -modelA.z);
        const scaleMat = new THREE.Matrix4().makeScale(scaleVec.x, scaleVec.y, scaleVec.z);
        const rotMat = new THREE.Matrix4().makeRotationFromQuaternion(quat);
        const toAR = new THREE.Matrix4().makeTranslation(
            this.anchorARPos.x + this.offsetX,
            this.anchorARPos.y + this.offsetY,
            this.anchorARPos.z + this.offsetZ
        );

        this.originMatrix.identity();
        this.originMatrix.multiply(toAR);
        this.originMatrix.multiply(rotMat);
        this.originMatrix.multiply(scaleMat);
        this.originMatrix.multiply(toOrigin);

        this.invOriginMatrix.copy(this.originMatrix).invert();

        // Update visual groups if attached to scene
        this._updateVisualTransform();
    }

    /** Update the visual meshes to match current transform */
    private _updateVisualTransform(): void {
        if (this.navMeshVisual) {
            this.navMeshVisual.matrixAutoUpdate = false;
            this.navMeshVisual.matrix.copy(this.originMatrix);
            this.navMeshVisual.matrixWorldNeedsUpdate = true;
        }
        if (this.roomMesh) {
            this.roomMesh.matrixAutoUpdate = false;
            this.roomMesh.matrix.copy(this.originMatrix);
            this.roomMesh.matrixWorldNeedsUpdate = true;
        }
        if (this.zoneMarkers) {
            this.zoneMarkers.matrixAutoUpdate = false;
            this.zoneMarkers.matrix.copy(this.originMatrix);
            this.zoneMarkers.matrixWorldNeedsUpdate = true;
        }
    }

    get rotationDegrees(): number {
        return this.rotationY * 180 / Math.PI;
    }

    // ── Coordinate conversion ────────────────────────────────────────────────

    modelToAR(modelPos: THREE.Vector3): THREE.Vector3 {
        if (!this.calibrated) return modelPos.clone();
        return modelPos.clone().applyMatrix4(this.originMatrix);
    }

    arToModel(arPos: THREE.Vector3): THREE.Vector3 {
        if (!this.calibrated) return arPos.clone();
        return arPos.clone().applyMatrix4(this.invOriginMatrix);
    }

    // ── Pathfinding ──────────────────────────────────────────────────────────

    findPathBetweenZones(fromId: string, toId: string): THREE.Vector3[] {
        const fz = this.zones.find(z => z.id === fromId);
        const tz = this.zones.find(z => z.id === toId);
        if (!fz || !tz) return [];

        if (!this.navMeshReady || !this.navMesh) {
            return [fz.snappedPosition.clone(), tz.snappedPosition.clone()];
        }

        const from = new YukaVector3(fz.snappedPosition.x, fz.snappedPosition.y, fz.snappedPosition.z);
        const to = new YukaVector3(tz.snappedPosition.x, tz.snappedPosition.y, tz.snappedPosition.z);

        const path = this.navMesh.findPath(from, to);
        if (!path || path.length === 0) {
            console.warn('⚠️ NavMesh findPath empty, direct line');
            return [fz.snappedPosition.clone(), tz.snappedPosition.clone()];
        }

        console.log(`[Path] ✅ ${path.length} waypoints via NavMesh`);
        return path.map((p: any) => new THREE.Vector3(p.x, p.y, p.z));
    }

    findPathInAR(fromId: string, toId: string): THREE.Vector3[] {
        return this.findPathBetweenZones(fromId, toId).map(p => this.modelToAR(p));
    }

    getZone(id: string): ZonePoint | undefined {
        return this.zones.find(z => z.id === id);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private _makeLabelSprite(text: string, color: number): THREE.Sprite {
        const canvas = document.createElement('canvas');
        const w = 512, h = 128;
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d')!;
        const hex = '#' + color.toString(16).padStart(6, '0');

        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        const r = 20;
        ctx.beginPath();
        ctx.moveTo(r, 0); ctx.lineTo(w - r, 0); ctx.quadraticCurveTo(w, 0, w, r);
        ctx.lineTo(w, h - r); ctx.quadraticCurveTo(w, h, w - r, h);
        ctx.lineTo(r, h); ctx.quadraticCurveTo(0, h, 0, h - r);
        ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0);
        ctx.fill();
        ctx.strokeStyle = hex; ctx.lineWidth = 3; ctx.stroke();

        ctx.fillStyle = hex;
        ctx.font = 'bold 44px Inter, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(text, w / 2, h / 2);

        const tex = new THREE.CanvasTexture(canvas);
        const mat = new THREE.SpriteMaterial({ map: tex, depthWrite: false });
        const spr = new THREE.Sprite(mat);
        spr.scale.set(0.4, 0.1, 1);
        return spr;
    }

    private _parseGeometry(geometry: THREE.BufferGeometry): any[] {
        const posAttr = geometry.attributes.position;
        const indexAttr = geometry.index;
        const vertices: any[] = [];
        for (let i = 0; i < posAttr.count; i++) {
            vertices.push(new YukaVector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)));
        }
        const polygons: any[] = [];
        if (indexAttr) {
            for (let i = 0; i < indexAttr.count; i += 3) {
                const a = indexAttr.getX(i), b = indexAttr.getX(i + 1), c = indexAttr.getX(i + 2);
                polygons.push(new Polygon().fromContour([vertices[a], vertices[b], vertices[c]]));
            }
        } else {
            for (let i = 0; i < vertices.length; i += 3) {
                polygons.push(new Polygon().fromContour([vertices[i], vertices[i + 1], vertices[i + 2]]));
            }
        }
        return polygons;
    }
}
