import * as THREE from 'three';

export type PlaneType = 'floor' | 'wall' | 'ceiling';

export interface DetectedPlane {
    id: string;
    center: THREE.Vector3;
    normal: THREE.Vector3;
    type: PlaneType;
    hitCount: number;          // сколько раз подтверждён (стабильность)
    lastSeen: number;          // timestamp последнего обнаружения
    area: number;              // оценка площади (по количеству попаданий)
}

/**
 * Улучшенная детекция плоскостей через hit-test нормали.
 * 
 * Изменения:
 *  - Более точная классификация: порог 0.6 (≈53°) для стен vs пол/потолок
 *  - Стабилизация: скользящее среднее позиции и нормали плоскости
 *  - Мердж-радиус увеличен для лучшей группировки точек в одну плоскость
 *  - Хранение hitCount для оценки надёжности плоскости
 *  - Авто-очистка «мёртвых» плоскостей (не видны > 5 сек)
 */
export class PlaneDetection {
    private readonly planes = new Map<string, DetectedPlane>();

    // ── Настройки ────────────────────────────────────────────────────────────
    private static readonly MERGE_RADIUS = 0.50;       // м — радиус слияния точек в одну плоскость
    private static readonly WALL_MERGE_RADIUS = 0.70;  // м — для стен побольше (они крупнее)
    private static readonly NORMAL_TOLERANCE = 0.35;   // компланарность нормалей (dot product)
    private static readonly STALE_TIMEOUT = 5000;      // мс — удалять плоскости, не видимые > 5 сек
    private static readonly SMOOTHING = 0.15;           // коэффициент скользящего среднего

    // Порог классификации: |normal.y| > WALL_THRESHOLD → горизонтальная (пол/потолок)
    // |normal.y| ≤ WALL_THRESHOLD → вертикальная (стена)
    // 0.6 = sin(~37°) — поверхности с наклоном до ~53° от вертикали считаются стеной
    private static readonly WALL_THRESHOLD = 0.6;

    // ── Public API ───────────────────────────────────────────────────────────

    update(hitPosition: THREE.Vector3, hitNormal: THREE.Vector3): DetectedPlane | null {
        const now = performance.now();
        const type = this._classify(hitNormal);

        // Ищем ближайшую плоскость того же типа с похожей нормалью
        let bestPlane: DetectedPlane | null = null;
        let bestDist = Infinity;
        const mergeR = type === 'wall'
            ? PlaneDetection.WALL_MERGE_RADIUS
            : PlaneDetection.MERGE_RADIUS;

        for (const plane of this.planes.values()) {
            if (plane.type !== type) continue;

            // Проверяем компланарность нормалей
            const normalDot = plane.normal.dot(hitNormal);
            if (normalDot < (1.0 - PlaneDetection.NORMAL_TOLERANCE)) continue;

            const d = plane.center.distanceTo(hitPosition);
            if (d < mergeR && d < bestDist) {
                bestDist = d;
                bestPlane = plane;
            }
        }

        if (bestPlane) {
            // Обновляем существующую плоскость скользящим средним
            const s = PlaneDetection.SMOOTHING;
            bestPlane.center.lerp(hitPosition, s);
            bestPlane.normal.lerp(hitNormal, s).normalize();
            bestPlane.hitCount++;
            bestPlane.lastSeen = now;
            bestPlane.area = Math.min(bestPlane.hitCount * 0.01, 10); // грубая оценка
            return bestPlane;
        }

        // Создаём новую плоскость
        const id = `pl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const plane: DetectedPlane = {
            id,
            center: hitPosition.clone(),
            normal: hitNormal.clone(),
            type,
            hitCount: 1,
            lastSeen: now,
            area: 0.01
        };
        this.planes.set(id, plane);
        return plane;
    }

    /**
     * Вызывать каждый кадр — удаляет «мёртвые» плоскости
     */
    tick(): void {
        const now = performance.now();
        for (const [id, plane] of this.planes) {
            if (now - plane.lastSeen > PlaneDetection.STALE_TIMEOUT) {
                this.planes.delete(id);
            }
        }
    }

    // ── Классификация поверхностей ───────────────────────────────────────────

    private _classify(n: THREE.Vector3): PlaneType {
        const absY = Math.abs(n.y);
        // |y| > 0.6 → пол или потолок (горизонтальная поверхность)
        // |y| ≤ 0.6 → стена (вертикальная поверхность)
        if (absY > PlaneDetection.WALL_THRESHOLD) {
            return n.y > 0 ? 'floor' : 'ceiling';
        }
        return 'wall';
    }

    // ── Запросы ──────────────────────────────────────────────────────────────

    getFloorPlanes(): DetectedPlane[] {
        return this._byType('floor');
    }

    getWallPlanes(): DetectedPlane[] {
        return this._byType('wall');
    }

    getCeilingPlanes(): DetectedPlane[] {
        return this._byType('ceiling');
    }

    /** Все плоскости, отсортированные по надёжности (hitCount) */
    getStablePlanes(minHits = 3): DetectedPlane[] {
        return Array.from(this.planes.values())
            .filter(p => p.hitCount >= minHits)
            .sort((a, b) => b.hitCount - a.hitCount);
    }

    /** Проверяет, является ли поверхность в данной позиции вертикальной */
    isVerticalAt(hitNormal: THREE.Vector3): boolean {
        return Math.abs(hitNormal.y) <= PlaneDetection.WALL_THRESHOLD;
    }

    planCount(): number { return this.planes.size; }
    floorCount(): number { return this._byType('floor').length; }
    wallCount(): number { return this._byType('wall').length; }

    private _byType(type: PlaneType): DetectedPlane[] {
        return Array.from(this.planes.values()).filter(p => p.type === type);
    }

    clear(): void { this.planes.clear(); }
    dispose(): void { this.clear(); }
}
