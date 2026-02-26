import * as THREE from 'three';

export type PlaneType = 'floor' | 'wall' | 'ceiling';

export interface DetectedPlane {
    id: string;
    center: THREE.Vector3;
    normal: THREE.Vector3;
    type: PlaneType;
}

/**
 * Определяет поверхности через hit-test нормали.
 * Визуальные меши СКРЫТЫ (opacity=0) — только логика обнаружения.
 */
export class PlaneDetection {
    private readonly planes = new Map<string, DetectedPlane>();
    private static readonly MERGE_RADIUS = 0.35;

    update(hitPosition: THREE.Vector3, hitNormal: THREE.Vector3): DetectedPlane | null {
        const type = this._classify(hitNormal);

        for (const plane of this.planes.values()) {
            if (
                plane.type === type &&
                plane.center.distanceTo(hitPosition) < PlaneDetection.MERGE_RADIUS
            ) {
                return plane;
            }
        }

        const id: string = `pl-${Date.now()}`;
        const plane: DetectedPlane = {
            id,
            center: hitPosition.clone(),
            normal: hitNormal.clone(),
            type
        };
        this.planes.set(id, plane);
        return plane;
    }

    private _classify(n: THREE.Vector3): PlaneType {
        const absY = Math.abs(n.y);
        if (absY > 0.707) return n.y > 0 ? 'floor' : 'ceiling';
        return 'wall';
    }

    getFloorPlanes(): DetectedPlane[] {
        return Array.from(this.planes.values()).filter(p => p.type === 'floor');
    }

    planCount(): number { return this.planes.size; }

    clear(): void { this.planes.clear(); }

    dispose(): void { this.clear(); }
}
