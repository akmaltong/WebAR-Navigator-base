export type StatusType = 'info' | 'success' | 'error';

export class UIManager {
    private readonly $entry = this._el('ar-entry');
    private readonly $badge = this._el('ar-badge');
    private readonly $guide = this._el('step-guide');
    private readonly $stepIcon = this._el('step-icon');
    private readonly $stepText = this._el('step-text');
    private readonly $loading = this._el('loading-screen');
    private readonly $wpCount = this._el('wp-count');
    private readonly $wpDots = this._el('wp-dots');
    private readonly $btnAdd = this._el<HTMLButtonElement>('btn-add');
    private readonly $btnRoute = this._el<HTMLButtonElement>('btn-route');
    private readonly $btnReset = this._el<HTMLButtonElement>('btn-reset');
    private readonly $status = this._el('status');

    constructor() {
        this._el('btn-enter-ar').addEventListener('click', () => this._emit('ar:enter'));
        this.$btnAdd.addEventListener('click', () => this._emit('ar:addwp'));
        this.$btnRoute.addEventListener('click', () => this._emit('ar:buildroute'));
        this.$btnReset.addEventListener('click', () => this._emit('ar:reset'));
    }

    private _el<T extends HTMLElement = HTMLElement>(id: string): T {
        return document.getElementById(id) as T;
    }

    private _emit(name: string): void {
        window.dispatchEvent(new CustomEvent(name));
    }

    // ── AR session state ──────────────────────────────────────────────────────

    setARActive(active: boolean): void {
        if (active) {
            this.$entry.classList.remove('on');
            this.$badge.classList.add('on');
            this.$guide.classList.add('on');
            this.$btnAdd.disabled = false;
        } else {
            this.$entry.classList.add('on');
            this.$badge.classList.remove('on');
            this.$guide.classList.remove('on');
            this.$btnAdd.disabled = true;
            this.$btnRoute.disabled = true;
        }
    }

    // ── Waypoint UI ───────────────────────────────────────────────────────────

    updateWaypoints(count: number): void {
        this.$wpCount.textContent = `${count} ${this._plural(count)}`;

        // Точки-индикаторы
        this.$wpDots.innerHTML = '';
        for (let i = 0; i < count; i++) {
            const d = document.createElement('div');
            d.className = `wp-dot ${i === 0 ? 'start' : i === count - 1 ? 'end' : 'mid'}`;
            this.$wpDots.appendChild(d);
        }

        // Кнопка маршрута: нужно ≥2 точек
        this.$btnRoute.disabled = count < 2;

        // Текст кнопки добавления
        if (count === 0) {
            this.$btnAdd.innerHTML = '📍 Старт';
            this.$stepIcon.textContent = '📍';
            this.$stepText.textContent = 'Наведи на пол и нажми «Старт»';
        } else {
            this.$btnAdd.innerHTML = `➕ Точка ${count + 1}`;
            this.$stepIcon.textContent = count === 1 ? '🚶' : '➕';
            this.$stepText.textContent = count === 1
                ? 'Иди к цели и добавь следующую точку'
                : `Точек: ${count}. Добавь ещё или строй маршрут`;
        }
    }

    setRouteBuilt(): void {
        this.$stepIcon.textContent = '✅';
        this.$stepText.textContent = 'Маршрут построен — следуй по стрелкам!';
        this.$btnAdd.disabled = true;
        this.$btnRoute.disabled = true;
    }

    // ── Status banner ─────────────────────────────────────────────────────────

    showStatus(msg: string, type: StatusType = 'info'): void {
        const icons: Record<StatusType, string> = { info: 'ℹ️', success: '✅', error: '❌' };
        this.$status.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
        this.$status.className = `on ${type}`;
    }

    clearStatus(): void {
        this.$status.className = '';
        this.$status.innerHTML = '';
    }

    hideLoading(): void {
        setTimeout(() => this.$loading.classList.add('hidden'), 1700);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private _plural(n: number): string {
        if (n === 1) return 'точка';
        if (n >= 2 && n <= 4) return 'точки';
        return 'точек';
    }
}
