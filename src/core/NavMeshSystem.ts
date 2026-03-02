import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
// @ts-ignore
import { NavMesh, Polygon, Vector3 as YukaVector3 } from 'yuka';

export class NavMeshSystem {
    public navMesh: any = null;
    public navMeshReady = false;
    public originMatrix = new THREE.Matrix4();
    private invOriginMatrix = new THREE.Matrix4();

    constructor() { }

    /** Загружаем Navmesh.glb и строим граф Yuka */
    public loadNavMesh(url: string): Promise<THREE.Group> {
        return new Promise((resolve, reject) => {
            const loader = new GLTFLoader();

            // Настройка DRACOLoader для распаковки сжатых GLB файлов
            const dracoLoader = new DRACOLoader();
            dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
            loader.setDRACOLoader(dracoLoader);

            loader.load(url, (gltf) => {
                let foundMesh: THREE.Mesh | undefined;

                // 1. Пытаемся найти NavMesh по имени (если экспортирован как Navmesh.001)
                gltf.scene.traverse((child) => {
                    if (child instanceof THREE.Mesh) {
                        if (child.name.toLowerCase().includes('navmesh') || child.name.toLowerCase().includes('nav_mesh')) {
                            foundMesh = child;
                        }
                    }
                });

                // 2. Если по имени не нашли, берем первый попавшийся
                if (!foundMesh) {
                    gltf.scene.traverse((child) => {
                        if (!foundMesh && child instanceof THREE.Mesh) {
                            foundMesh = child;
                        }
                    });
                }

                if (!foundMesh) {
                    reject(new Error('No mesh found in NavMesh GLB'));
                    return;
                }

                console.log('Using NavMesh:', foundMesh.name);

                // Применяем локальные трансформации
                foundMesh.updateMatrixWorld(true);
                const geometry = foundMesh.geometry.clone();
                geometry.applyMatrix4(foundMesh.matrixWorld);

                try {
                    const polygons = this.parseGeometry(geometry);
                    this.navMesh = new NavMesh();
                    this.navMesh.fromPolygons(polygons);
                    this.navMeshReady = true;
                    console.log('✅ Yuka NavMesh loaded. Regions:', this.navMesh.regions.length);
                    resolve(gltf.scene);
                } catch (err) {
                    console.error('❌ Failed to build Yuka NavMesh:', err);
                    reject(err);
                }
            }, undefined, reject);
        });
    }

    public setOrigin(pos: THREE.Vector3, quat: THREE.Quaternion, scale: THREE.Vector3 = new THREE.Vector3(1, 1, 1)) {
        this.originMatrix.compose(pos, quat, scale);
        // Дополнительная инверсия требуется для перевода координат из AR в локальные NavMesh
        this.invOriginMatrix.copy(this.originMatrix).invert();
        console.log('🎯 Origin calibrated');
    }

    /** Найти путь от точки A до точки B в AR координатах */
    public findPath(startArPos: THREE.Vector3, endArPos: THREE.Vector3): THREE.Vector3[] {
        if (!this.navMeshReady || !this.navMesh) return [endArPos];

        // 1. Переводим AR координаты в координаты локального NavMesh (комнаты/модели)
        const localStart = startArPos.clone().applyMatrix4(this.invOriginMatrix);
        const localEnd = endArPos.clone().applyMatrix4(this.invOriginMatrix);

        // 2. Преобразуем в вектор Yuka
        const from = new YukaVector3(localStart.x, localStart.y, localStart.z);
        const to = new YukaVector3(localEnd.x, localEnd.y, localEnd.z);

        // 3. Вызываем алгоритм A* (Funnel algorithm в Yuka)
        const path = this.navMesh.findPath(from, to);

        if (!path || path.length === 0) {
            console.warn('⚠️ No route found on NavMesh. Using direct line.');
            return [startArPos, endArPos]; // fall back to direct line
        }

        // 4. Переводим локальный путь Yuka обратно в глобальные AR координаты
        const worldPath = path.map((p: any) => {
            const localPt = new THREE.Vector3(p.x, p.y, p.z);
            return localPt.applyMatrix4(this.originMatrix);
        });

        return worldPath;
    }

    // Парсим BufferGeometry в объекты Yuka
    private parseGeometry(geometry: THREE.BufferGeometry): any[] {
        const posAttr = geometry.attributes.position;
        const indexAttr = geometry.index;

        const vertices: any[] = [];
        for (let i = 0; i < posAttr.count; i++) {
            const v = new YukaVector3();
            v.x = posAttr.getX(i);
            v.y = posAttr.getY(i);
            v.z = posAttr.getZ(i);
            vertices.push(v);
        }

        const polygons: any[] = [];
        if (indexAttr) {
            for (let i = 0; i < indexAttr.count; i += 3) {
                const a = indexAttr.getX(i);
                const b = indexAttr.getX(i + 1);
                const c = indexAttr.getX(i + 2);

                const contour = [vertices[a], vertices[b], vertices[c]];
                const polygon = new Polygon().fromContour(contour);
                polygons.push(polygon);
            }
        } else {
            for (let i = 0; i < vertices.length; i += 3) {
                const contour = [vertices[i], vertices[i + 1], vertices[i + 2]];
                const polygon = new Polygon().fromContour(contour);
                polygons.push(polygon);
            }
        }
        return polygons;
    }
}
