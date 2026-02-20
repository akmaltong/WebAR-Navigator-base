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
    private readonly $btnAdd = this._el<HTMLButtonElement>('btn-calibrate');
    private readonly $btnRoute = this._el<HTMLButtonElement>('btn-dest');
    private readonly $btnReset = this._el<HTMLButtonElement>('btn-reset');
    private readonly $status = this._el('status');

    // Bottom sheet
    private readonly $sheetOverlay = this._el('sheet-overlay');
    private readonly $locationMenu = this._el('location-menu');
    private readonly $locationList = this._el('location-list');

    public debug(msg: string): void {
        let el = document.getElementById('debug-log');
        if (!el) {
            el = document.createElement('div');
            el.id = 'debug-log';
            el.style.cssText = 'position:fixed;top:60px;left:10px;width:calc(100% - 20px);height:25%;overflow-y:auto;pointer-events:none;background:rgba(0,0,0,0.7);color:#0f0;font-family:monospace;font-size:12px;z-index:999999;padding:8px;border-radius:8px;white-space:pre-wrap;';
            document.body.appendChild(el);
        }
        el.innerText = msg + '\n' + el.innerText;
        console.log('[DEBUG]', msg);
    }

    constructor() {
        this._el('btn-enter-ar').addEventListener('click', () => this._emit('ar:enter'));
        this.$btnAdd.addEventListener('click', () => this._emit('ar:calibrate'));

        // Теперь кнопка просто открывает менюшку, а не сразу строит маршрут
        this.$btnRoute.addEventListener('click', () => {
            this.debug('Opened menu! Spots: ' + this.$locationList.children.length);
            this.showLocationMenu();
        });

        this.$btnReset.addEventListener('click', () => this._emit('ar:reset'));

        // Закрытие по клику в любую темную область вокруг меню
        this.$sheetOverlay.addEventListener('click', () => this.hideLocationMenu());
    }

    // ── Location Menu ────────────────────────────────────────────────────────

    showLocationMenu(): void {
        this.$sheetOverlay.classList.add('on');
        this.$locationMenu.classList.add('on');
    }

    hideLocationMenu(): void {
        this.$sheetOverlay.classList.remove('on');
        this.$locationMenu.classList.remove('on');
    }

    renderLocations(locations: { id: string; name: string; icon: string }[]): void {
        console.log('[HTML RENDER] Locations count:', locations.length);
        this.debug('renderLocations received: ' + locations.length);
        this.$locationList.innerHTML = '';
        locations.forEach(loc => {
            const btn = document.createElement('button');
            btn.className = 'loc-btn';
            btn.innerHTML = `<div class="loc-icon">${loc.icon}</div>${loc.name}`;

            btn.addEventListener('click', () => {
                this.hideLocationMenu();
                // Эмитим кастомное событие с ID пункта
                window.dispatchEvent(new CustomEvent('ar:selectdest', { detail: { id: loc.id } }));
            });
            this.$locationList.appendChild(btn);
        });
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

            // Сброс UI в начальное состояние
            this.$btnAdd.style.display = '';
            this.$btnAdd.disabled = false;
            this.$btnRoute.style.display = 'none';
            this.$btnRoute.disabled = true;

            this.$stepIcon.textContent = '🎯';
            this.$stepText.textContent = 'Наведите прицел на маркер и нажмите «НАЗНАЧИТЬ СТАРТ»';
            this.$btnAdd.innerHTML = '🎯 НАЗНАЧИТЬ СТАРТ';
        } else {
            this.$entry.classList.add('on');
            this.$badge.classList.remove('on');
            this.$guide.classList.remove('on');
            this.$btnAdd.disabled = true;
            this.$btnRoute.disabled = true;
        }
    }

    // ── Calibration & Destination UI ──────────────────────────────────────────

    setCalibrated(): void {
        this.$btnAdd.style.display = 'none';
        this.$btnRoute.style.display = '';
        this.$btnRoute.disabled = false;

        this.$stepIcon.textContent = '📍';
        this.$stepText.textContent = 'Выбери нужное место и нажми «Куда идти?»';
        this.$wpCount.textContent = 'Откалибровано';
        this.$wpDots.innerHTML = '<div class="wp-dot start"></div>';
    }

    setRouteBuilt(): void {
        this.$stepIcon.textContent = '✅';
        this.$stepText.textContent = 'Маршрут построен — следуй по стрелкам!';
        this.$btnRoute.disabled = true;
        this.$wpCount.textContent = 'В пути';
        this.$wpDots.innerHTML = '<div class="wp-dot start"></div><div class="wp-dot end"></div>';
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
}
