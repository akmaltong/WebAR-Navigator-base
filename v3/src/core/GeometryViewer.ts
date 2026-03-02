import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

export interface GeometryLayers {
    navmesh: boolean;
    walls: boolean;
    points: boolean;
}

/**
 * GeometryViewer — загрузка и отображение 3D-геометрии (навмеш, стены, точки).
 * 
 * Все модели помещаются в единую группу `root`, которую можно
 * масштабировать, перемещать и вращать через контроллеры UI.
 */
export class GeometryViewer {
    private readonly scene: THREE.Scene;
    private readonly loader: GLTFLoader;

    /** Корневая группа — все модели внутри неё */
    readonly root = new THREE.Group();

    /** Отдельные слои */
    private navmeshGroup = new THREE.Group();
    private wallsGroup = new THREE.Group();
    private pointsGroup = new THREE.Group();

    private _loaded = false;

    constructor(scene: THREE.Scene) {
        this.scene = scene;

        this.loader = new GLTFLoader();
        const draco = new DRACOLoader();
        draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
        this.loader.setDRACOLoader(draco);

        this.navmeshGroup.name = 'navmesh';
        this.wallsGroup.name = 'walls';
        this.pointsGroup.name = 'points';

        this.root.add(this.navmeshGroup);
        this.root.add(this.wallsGroup);
        this.root.add(this.pointsGroup);

        // Не добавляем в сцену пока не загрузим
        this.root.visible = false;
    }

    get loaded(): boolean { return this._loaded; }

    // ── Загрузка ─────────────────────────────────────────────────────────────

    async load(navmeshUrl: string, wallsUrl: string, pointsUrl: string): Promise<void> {
        const results = await Promise.allSettled([
            this._loadModel(navmeshUrl, this.navmeshGroup, 'navmesh'),
            this._loadModel(wallsUrl, this.wallsGroup, 'walls'),
            this._loadModel(pointsUrl, this.pointsGroup, 'points'),
        ]);

        results.forEach((r, i) => {
            if (r.status === 'rejected') {
                console.warn(`[GeometryViewer] Failed to load model ${i}:`, r.reason);
            }
        });

        this.scene.add(this.root);
        this.root.visible = true;
        this._loaded = true;

        // Материалы по умолчанию
        this._applyMaterials();

        console.log('[GeometryViewer] All models loaded');
    }

    private _loadModel(url: string, group: THREE.Group, label: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.loader.load(
                url,
                (gltf) => {
                    gltf.scene.traverse((child) => {
                        if (child instanceof THREE.Mesh) {
                            child.frustumCulled = false;
                        }
                    });
                    group.add(gltf.scene);
                    console.log(`[GeometryViewer] Loaded ${label}`);
                    resolve();
                },
                undefined,
                (err) => reject(err)
            );
        });
    }

    /** Применяем полупрозрачные материалы для визуализации в AR */
    private _applyMaterials(): void {
        // Навмеш — полупрозрачная зелёная сетка
        this.navmeshGroup.traverse((child) => {
            if (child instanceof THREE.Mesh) {
                child.material = new THREE.MeshBasicMaterial({
                    color: 0x00ff88,
                    transparent: true,
                    opacity: 0.25,
                    wireframe: true,
                    side: THREE.DoubleSide,
                    depthWrite: false,
                });
            }
        });

        // Стены — полупрозрачный голубой
        this.wallsGroup.traverse((child) => {
            if (child instanceof THREE.Mesh) {
                child.material = new THREE.MeshBasicMaterial({
                    color: 0x4488ff,
                    transparent: true,
                    opacity: 0.18,
                    side: THREE.DoubleSide,
                    depthWrite: false,
                });
            }
        });

        // Точки — яркие жёлтые
        this.pointsGroup.traverse((child) => {
            if (child instanceof THREE.Mesh) {
                child.material = new THREE.MeshBasicMaterial({
                    color: 0xffcc00,
                    transparent: true,
                    opacity: 0.7,
                    depthWrite: false,
                });
            }
        });
    }

    // ── Управление слоями ────────────────────────────────────────────────────

    setLayerVisibility(layers: GeometryLayers): void {
        this.navmeshGroup.visible = layers.navmesh;
        this.wallsGroup.visible = layers.walls;
        this.pointsGroup.visible = layers.points;
    }

    getLayerVisibility(): GeometryLayers {
        return {
            navmesh: this.navmeshGroup.visible,
            walls: this.wallsGroup.visible,
            points: this.pointsGroup.visible,
        };
    }

    toggleLayer(layer: keyof GeometryLayers): boolean {
        const group = layer === 'navmesh' ? this.navmeshGroup
            : layer === 'walls' ? this.wallsGroup
                : this.pointsGroup;
        group.visible = !group.visible;
        return group.visible;
    }

    // ── Трансформации ────────────────────────────────────────────────────────

    setPosition(x: number, y: number, z: number): void {
        this.root.position.set(x, y, z);
    }

    translate(dx: number, dy: number, dz: number): void {
        this.root.position.x += dx;
        this.root.position.y += dy;
        this.root.position.z += dz;
    }

    setScale(s: number): void {
        this.root.scale.setScalar(s);
    }

    getScale(): number {
        return this.root.scale.x;
    }

    setRotationY(degrees: number): void {
        this.root.rotation.y = THREE.MathUtils.degToRad(degrees);
    }

    getRotationY(): number {
        return THREE.MathUtils.radToDeg(this.root.rotation.y);
    }

    rotateY(degrees: number): void {
        this.root.rotation.y += THREE.MathUtils.degToRad(degrees);
    }

    getPosition(): THREE.Vector3 {
        return this.root.position.clone();
    }

    // ── Навигация с навмешем ─────────────────────────────────────────────────

    /** Получить матрицу трансформации root-группы (для NavMeshSystem.setOrigin) */
    getWorldMatrix(): THREE.Matrix4 {
        this.root.updateMatrixWorld(true);
        return this.root.matrixWorld.clone();
    }

    // ── Очистка ──────────────────────────────────────────────────────────────

    dispose(): void {
        this.scene.remove(this.root);
        this.root.traverse((child) => {
            if (child instanceof THREE.Mesh) {
                child.geometry?.dispose();
                const mat = child.material;
                if (Array.isArray(mat)) mat.forEach(m => m.dispose());
                else mat?.dispose();
            }
        });
    }
}
