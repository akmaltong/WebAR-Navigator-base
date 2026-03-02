import * as THREE from 'three';

export class FeaturePoints {
    private readonly scene: THREE.Scene;
    private readonly ringGroup: THREE.Group;
    private readonly pointMats: THREE.MeshBasicMaterial[] = [];

    constructor(scene: THREE.Scene) {
        this.scene = scene;
        this.ringGroup = new THREE.Group();
        this.ringGroup.visible = false;

        // Размер точек уменьшен в два раза (0.015 -> 0.0075)
        const geo = new THREE.CircleGeometry(0.0075, 12);

        // Заполняем пространство кольцами (от прицела ~0.04 до радиуса ~0.09)
        const rings = [
            { r: 0.05, count: 6 },
            { r: 0.07, count: 12 },
            { r: 0.09, count: 18 }
        ];

        rings.forEach(({ r, count }) => {
            for (let i = 0; i < count; i++) {
                const angle = (i / count) * Math.PI * 2;
                const mat = new THREE.MeshBasicMaterial({
                    color: 0xffffff,
                    transparent: true,
                    opacity: 0.8,
                    depthWrite: false,
                    side: THREE.DoubleSide
                });
                const mesh = new THREE.Mesh(geo, mat);

                mesh.position.set(Math.cos(angle) * r, 0.005, Math.sin(angle) * r);
                mesh.rotation.x = -Math.PI / 2;

                this.ringGroup.add(mesh);
                this.pointMats.push(mat);
            }
        });

        scene.add(this.ringGroup);
    }

    updatePose(pos: THREE.Vector3, quaternion: THREE.Quaternion, time: number): void {
        this.ringGroup.position.lerp(pos, 0.3); // "быстро прилипает" (интерполяция вместо телепорта)
        this.ringGroup.quaternion.slerp(quaternion, 0.3);
        this.ringGroup.visible = true;

        // Плавное вращение самого круга
        this.ringGroup.rotation.y += 0.005;

        // Волна прозрачности и пульсации размера
        const tScale = time / 400;
        this.ringGroup.children.forEach((mesh, i) => {
            const angle = (i / this.ringGroup.children.length) * Math.PI * 2;
            const wave = (Math.sin(tScale + angle * 3) + 1) / 2;
            this.pointMats[i].opacity = 0.15 + 0.6 * wave;
            const scale = 0.6 + 0.6 * wave;
            mesh.scale.set(scale, scale, scale);
        });
    }

    update(nowMs: number = performance.now()): void {
        // Оставим для совместимости API, если нужно. Реальная анимация перенесена в updatePose.
    }

    clear(): void {
        this.ringGroup.visible = false;
    }

    dispose(): void {
        this.scene.remove(this.ringGroup);
        this.ringGroup.children.forEach((mesh: any) => mesh.geometry?.dispose());
        this.pointMats.forEach(m => m.dispose());
    }
}
