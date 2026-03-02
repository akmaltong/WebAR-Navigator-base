import * as THREE from 'three';

export class MathHelpers {
    static lerp(a: number, b: number, t: number): number {
        return a + (b - a) * t;
    }

    static clamp(v: number, min: number, max: number): number {
        return Math.max(min, Math.min(max, v));
    }

    static dist3(a: THREE.Vector3, b: THREE.Vector3): number {
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dz = a.z - b.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    static randomRange(min: number, max: number): number {
        return min + Math.random() * (max - min);
    }

    static degToRad(deg: number): number {
        return (deg * Math.PI) / 180;
    }

    static radToDeg(rad: number): number {
        return (rad * 180) / Math.PI;
    }
}
