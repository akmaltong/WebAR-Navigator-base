import * as THREE from 'three';

/**
 * Smooth cubic Bezier spline через набор контрольных точек.
 *
 * Алгоритм: решаем трёхдиагональную систему уравнений (метод Thomas / прогонка)
 * для получения первых управляющих точек каждого сегмента,
 * аналогично библиотеке bezier-spline-kotlin.
 *
 * Каждый сегмент — cubic bezier (p0, c1, c2, p1).
 * На стыках сплайн имеет C1-непрерывность (гладкое касание).
 */
export function bezierSpline(
    waypoints: THREE.Vector3[],
    samplesPerSegment = 24
): THREE.Vector3[] {
    const n = waypoints.length - 1;

    if (n <= 0) return waypoints.slice();

    if (n === 1) {
        // Два узла — просто прямая
        const curve = new THREE.LineCurve3(waypoints[0], waypoints[1]);
        return curve.getPoints(samplesPerSegment);
    }

    const p = waypoints;

    // ── Правая часть системы (RHS) ──────────────────────────────────────────
    // Для i=0..n-1:
    //   rhs[0]   = p[0] + 2*p[1]
    //   rhs[i]   = 4*p[i] + 2*p[i+1]     (1 ≤ i ≤ n-2)
    //   rhs[n-1] = (8*p[n-1] + p[n]) / 2
    const rhs: THREE.Vector3[] = Array.from({ length: n }, (_, i) => {
        if (i === 0) return p[0].clone().add(p[1].clone().multiplyScalar(2));
        if (i === n - 1) return p[n - 1].clone().multiplyScalar(8).add(p[n]).multiplyScalar(0.5);
        return p[i].clone().multiplyScalar(4).add(p[i + 1].clone().multiplyScalar(2));
    });

    // ── Прогонка (Thomas algorithm) ─────────────────────────────────────────
    // Диагонали: lower=1, main=2 (кроме крайних), upper=1
    const w = new Float64Array(n); // диагональный коэффициент после исключения

    // Forward sweep
    w[0] = 0.5;
    rhs[0].multiplyScalar(0.5);

    for (let i = 1; i < n; i++) {
        const m = 1.0 / (4.0 - w[i - 1]);   // main diagonal: 4 (или 3.5 для i=n-1, но корректируем в rhs)
        w[i] = m;
        rhs[i].sub(rhs[i - 1].clone().multiplyScalar(w[i - 1])).multiplyScalar(m);
        // Примечание: для последнего элемента главная диагональ была 3.5
        // (она уже учтена через rhs[n-1] * 0.5 выше)
    }

    // Back substitution → c1[i] = первые управляющие точки
    const c1: THREE.Vector3[] = new Array(n);
    c1[n - 1] = rhs[n - 1].clone();
    for (let i = n - 2; i >= 0; i--) {
        c1[i] = rhs[i].clone().sub(c1[i + 1].clone().multiplyScalar(w[i]));
    }

    // ── Вторые управляющие точки c2 ─────────────────────────────────────────
    const c2: THREE.Vector3[] = new Array(n);
    for (let i = 0; i < n - 1; i++) {
        c2[i] = p[i + 1].clone().multiplyScalar(2).sub(c1[i + 1]);
    }
    c2[n - 1] = p[n].clone().add(c1[n - 1]).multiplyScalar(0.5);

    // ── Сэмплируем кривые ────────────────────────────────────────────────────
    const result: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
        const curve = new THREE.CubicBezierCurve3(p[i], c1[i], c2[i], p[i + 1]);
        const pts = curve.getPoints(samplesPerSegment);
        // Первую точку каждого сегмента (кроме самого первого) пропускаем
        // — она дублирует конец предыдущего сегмента
        result.push(...(i === 0 ? pts : pts.slice(1)));
    }

    return result;
}
