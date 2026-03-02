import { ZonePoint } from '../core/RoomNavSystem';

export type StatusType = 'info' | 'success' | 'error';
export type NavPhase = 'menu' | 'ar-entry' | 'placing' | 'placing-b' | 'calibrating' | 'navigating';

export class UIManager {
    private readonly $mainMenu = this._el('main-menu');
    private readonly $selectFrom = this._el<HTMLSelectElement>('select-from');
    private readonly $selectTo = this._el<HTMLSelectElement>('select-to');
    private readonly $btnNavigate = this._el<HTMLButtonElement>('btn-navigate');
    private readonly $btnCalibrate = this._el<HTMLButtonElement>('btn-calibrate');

    private readonly $entry = this._el('ar-entry');
    private readonly $entryDestLabel = this._el('entry-dest-label');

    private readonly $badge = this._el('ar-badge');
    private readonly $guide = this._el('step-guide');
    private readonly $stepIcon = this._el('step-icon');
    private readonly $stepText = this._el('step-text');
    private readonly $loading = this._el('loading-screen');
    private readonly $btnPlace = this._el<HTMLButtonElement>('btn-place');
    private readonly $btnCancel = this._el<HTMLButtonElement>('btn-cancel');
    private readonly $status = this._el('status');
    private readonly $navDest = this._el('nav-dest');
    private readonly $navDistance = this._el('nav-distance');
    private readonly $wpStrip = this._el('wp-strip');
    private readonly $routeSummary = this._el('route-summary');
    private readonly $routeSteps = this._el('route-steps');

    // Calibration controls
    private readonly $calibPanel = this._el('calib-panel');
    private readonly $calibAngle = this._el('calib-angle');
    private readonly $calibOffset = this._el('calib-offset');

    constructor() {
        this.$selectFrom.addEventListener('change', () => this._validate());
        this.$selectTo.addEventListener('change', () => this._validate());
        this.$btnNavigate.addEventListener('click', () => this._emit('nav:start'));
        this.$btnCalibrate.addEventListener('click', () => this._emit('nav:calibrate'));
        this._el('btn-enter-ar').addEventListener('click', () => this._emit('ar:enter'));
        this.$btnPlace.addEventListener('click', () => this._emit('ar:place'));
        this.$btnCancel.addEventListener('click', () => this._emit('nav:cancel'));

        // Calibration gizmo buttons
        this._el('btn-rot-left').addEventListener('click', () => this._emit('calib:rotate-left'));
        this._el('btn-rot-right').addEventListener('click', () => this._emit('calib:rotate-right'));
        this._el('btn-rot-left-fine').addEventListener('click', () => this._emit('calib:rotate-left-fine'));
        this._el('btn-rot-right-fine').addEventListener('click', () => this._emit('calib:rotate-right-fine'));

        // Move buttons
        this._el('btn-move-fwd').addEventListener('click', () => this._emit('calib:move-forward'));
        this._el('btn-move-back').addEventListener('click', () => this._emit('calib:move-back'));
        this._el('btn-move-left').addEventListener('click', () => this._emit('calib:move-left'));
        this._el('btn-move-right').addEventListener('click', () => this._emit('calib:move-right'));
        this._el('btn-move-up').addEventListener('click', () => this._emit('calib:move-up'));
        this._el('btn-move-down').addEventListener('click', () => this._emit('calib:move-down'));

        this._el('btn-move-fwd-fine').addEventListener('click', () => this._emit('calib:move-forward-fine'));
        this._el('btn-move-back-fine').addEventListener('click', () => this._emit('calib:move-back-fine'));
        this._el('btn-move-left-fine').addEventListener('click', () => this._emit('calib:move-left-fine'));
        this._el('btn-move-right-fine').addEventListener('click', () => this._emit('calib:move-right-fine'));
        this._el('btn-move-up-fine').addEventListener('click', () => this._emit('calib:move-up-fine'));
        this._el('btn-move-down-fine').addEventListener('click', () => this._emit('calib:move-down-fine'));

        // Scale buttons
        this._el('btn-scale-up').addEventListener('click', () => this._emit('calib:scale-up'));
        this._el('btn-scale-down').addEventListener('click', () => this._emit('calib:scale-down'));

        this._el('btn-calib-save').addEventListener('click', () => this._emit('calib:save'));
        this._el('btn-calib-build').addEventListener('click', () => this._emit('calib:build'));
    }

    private _el<T extends HTMLElement = HTMLElement>(id: string): T {
        return document.getElementById(id) as T;
    }
    private _emit(name: string): void {
        window.dispatchEvent(new CustomEvent(name));
    }

    // ── Populate ─────────────────────────────────────────────────────────────

    populateZones(zones: ZonePoint[]): void {
        const fill = (sel: HTMLSelectElement, ph: string, withAuto: boolean = false) => {
            sel.innerHTML = '';
            const o0 = document.createElement('option');
            o0.value = ''; o0.textContent = ph; o0.disabled = true; o0.selected = true;
            sel.appendChild(o0);

            if (withAuto) {
                const autoOpt = document.createElement('option');
                autoOpt.value = 'auto-scan';
                autoOpt.textContent = '📷 Найти меня по коду (AprilTag)';
                sel.appendChild(autoOpt);
            }

            for (const z of zones) {
                const o = document.createElement('option');
                o.value = z.id; o.textContent = z.label;
                sel.appendChild(o);
            }
        };
        fill(this.$selectFrom, '— Где вы? —', true);
        fill(this.$selectTo, '— Куда? —', false);
    }

    getSelectedFrom(): string { return this.$selectFrom.value; }
    getSelectedTo(): string { return this.$selectTo.value; }

    private _validate(): void {
        const ok = !!this.$selectFrom.value && !!this.$selectTo.value && this.$selectFrom.value !== this.$selectTo.value;
        this.$btnNavigate.disabled = !ok;
        this.$btnCalibrate.disabled = !ok;
    }

    // ── Phases ───────────────────────────────────────────────────────────────

    setPhase(phase: NavPhase, label?: string, calibMode?: boolean): void {
        this.$mainMenu.classList.add('hidden');
        this.$entry.classList.remove('on');
        this.$guide.classList.remove('on');
        this.$calibPanel.classList.remove('on');

        switch (phase) {
            case 'menu':
                this.$mainMenu.classList.remove('hidden');
                this.$routeSummary.classList.remove('on');
                break;

            case 'ar-entry':
                this.$entryDestLabel.textContent = `→ ${label || '...'}`;
                this._el('entry-desc').textContent = calibMode
                    ? 'Режим калибровки: отметьте позицию, затем вращайте модель пока стены не совпадут'
                    : 'Отметьте своё положение на полу — маршрут построится автоматически';
                this.$entry.classList.add('on');
                break;

            case 'placing':
                this.$guide.classList.add('on');
                this.$stepIcon.textContent = '📍';
                this.$stepText.textContent = `Встань у «${label}», наведи на пол`;
                this.$btnPlace.disabled = false;
                this.$btnPlace.innerHTML = calibMode
                    ? `🔧 1. Я у «${label}»`
                    : `📍 Я тут — построить маршрут`;
                break;

            case 'placing-b':
                this.$guide.classList.add('on');
                this.$stepIcon.textContent = '📍';
                this.$stepText.textContent = `Шаг 2: Встань у «${label}», наведи сетку на пол`;
                this.$btnPlace.disabled = false;
                this.$btnPlace.innerHTML = `🔧 2. Я у «${label}» — привязать сетку`;
                break;

            case 'calibrating':
                this.$guide.classList.add('on');
                this.$stepIcon.textContent = '🔧';
                this.$stepText.textContent = 'Вращай модель ◀ ▶';
                this.$calibPanel.classList.add('on');
                this.$btnPlace.disabled = true;
                this.$btnPlace.innerHTML = '🔧 Калибровка...';
                break;

            case 'navigating':
                this.$guide.classList.add('on');
                this.$stepIcon.textContent = '🧭';
                this.$stepText.textContent = 'Следуй по стрелкам!';
                this.$btnPlace.disabled = true;
                this.$btnPlace.innerHTML = '✅ Маршрут построен';
                break;
        }
    }

    // ── Calib angle display ──────────────────────────────────────────────────

    updateCalibDisplay(degrees: number, offsetX: number, offsetY: number, offsetZ: number, scale: number): void {
        this.$calibAngle.textContent = `${degrees.toFixed(1)}°`;
        this.$calibOffset.textContent = `X:${offsetX.toFixed(2)} Y:${offsetY.toFixed(2)} Z:${offsetZ.toFixed(2)} S:${scale.toFixed(2)}`;
    }

    // ── AR badge ─────────────────────────────────────────────────────────────

    setARActive(active: boolean): void {
        if (active) this.$badge.classList.add('on');
        else { this.$badge.classList.remove('on'); this.$guide.classList.remove('on'); }
    }

    // ── Nav info ─────────────────────────────────────────────────────────────

    setNavDestination(l: string): void { this.$navDest.textContent = `→ ${l}`; }

    setNavDistance(m: number): void {
        this.$navDistance.textContent = m < 1 ? `${Math.round(m * 100)} см` : `~${m.toFixed(1)} м`;
    }

    showRouteSteps(labels: string[], idx: number): void {
        this.$routeSummary.classList.add('on');
        this.$routeSteps.innerHTML = '';
        labels.forEach((l, i) => {
            const li = document.createElement('li');
            if (i === idx) li.classList.add('active');
            li.innerHTML = `<span class="step-dot"></span> ${l}`;
            this.$routeSteps.appendChild(li);
        });
    }

    updateWaypointStrip(total: number, idx: number): void {
        this.$wpStrip.innerHTML = '';
        for (let i = 0; i < total; i++) {
            const d = document.createElement('div');
            d.className = 'wp-node';
            if (i < idx) d.classList.add('passed');
            else if (i === idx) d.classList.add('current');
            this.$wpStrip.appendChild(d);
        }
    }

    // ── Status ───────────────────────────────────────────────────────────────

    showStatus(msg: string, type: StatusType = 'info'): void {
        const ic: Record<StatusType, string> = { info: 'ℹ️', success: '✅', error: '❌' };
        this.$status.innerHTML = `<span>${ic[type]}</span><span>${msg}</span>`;
        this.$status.className = `on ${type}`;
    }

    clearStatus(): void { this.$status.className = ''; this.$status.innerHTML = ''; }

    hideLoading(): void {
        setTimeout(() => this.$loading.classList.add('hidden'), 1700);
    }
}
