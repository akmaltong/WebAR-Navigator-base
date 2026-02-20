import * as THREE from 'three';
import { ARButton } from 'three/examples/jsm/webxr/ARButton.js';

export class WebARSession {
    readonly container: HTMLElement;
    readonly renderer: THREE.WebGLRenderer;
    readonly scene: THREE.Scene;
    readonly camera: THREE.PerspectiveCamera;
    readonly reticle: THREE.Mesh;

    isARActive = false;
    private _arButtonEl: HTMLElement | null = null;

    constructor(container: HTMLElement) {
        this.container = container;

        // Scene
        this.scene = new THREE.Scene();

        // Camera
        this.camera = new THREE.PerspectiveCamera(
            70,
            window.innerWidth / window.innerHeight,
            0.01,
            50
        );

        // Renderer
        this.renderer = new THREE.WebGLRenderer({
            alpha: true,
            antialias: true,
            powerPreference: 'high-performance'
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.xr.enabled = true;
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        container.appendChild(this.renderer.domElement);

        // Lighting
        this._setupLighting();

        // Reticle
        this.reticle = this._createReticle();
        this.scene.add(this.reticle);

        window.addEventListener('resize', () => this._onResize());
    }

    private _setupLighting(): void {
        const ambient = new THREE.AmbientLight(0xffffff, 1.2);
        this.scene.add(ambient);

        const dir = new THREE.DirectionalLight(0xffffff, 0.8);
        dir.position.set(5, 10, 5);
        dir.castShadow = true;
        this.scene.add(dir);

        // Soft hemisphere
        const hemi = new THREE.HemisphereLight(0x8080ff, 0x404040, 0.6);
        this.scene.add(hemi);
    }

    private _createReticle(): THREE.Mesh {
        const geo = new THREE.RingGeometry(0.022, 0.038, 32);
        geo.rotateX(-Math.PI / 2);
        const mat = new THREE.MeshBasicMaterial({
            color: 0x00ff88,
            transparent: true,
            opacity: 0.85,
            side: THREE.DoubleSide
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.visible = false;
        // Inner dot
        const dotGeo = new THREE.CircleGeometry(0.008, 16);
        dotGeo.rotateX(-Math.PI / 2);
        const dotMat = new THREE.MeshBasicMaterial({ color: 0x00ff88, side: THREE.DoubleSide });
        const dot = new THREE.Mesh(dotGeo, dotMat);
        dot.position.y = 0.001;
        mesh.add(dot);
        return mesh;
    }

    async initializeAR(): Promise<boolean> {
        if (!('xr' in navigator)) {
            console.warn('[WebARSession] WebXR not available');
            return false;
        }
        try {
            const supported = await navigator.xr!.isSessionSupported('immersive-ar');
            if (!supported) {
                console.warn('[WebARSession] immersive-ar not supported');
                return false;
            }

            const uiOverlay = document.getElementById('ui-overlay')!;

            this._arButtonEl = ARButton.createButton(this.renderer, {
                requiredFeatures: ['hit-test'],
                optionalFeatures: ['local-floor', 'dom-overlay'],
                domOverlay: { root: uiOverlay }
            });

            // Hide the default ARButton — we trigger it programmatically
            this._arButtonEl.style.cssText =
                'position:fixed;bottom:-9999px;opacity:0;pointer-events:none;';
            document.body.appendChild(this._arButtonEl);

            this.renderer.xr.addEventListener('sessionstart', () => {
                this.isARActive = true;
                this.reticle.visible = true;
                document.getElementById('ar-badge')?.classList.add('visible');
                document.getElementById('ar-button')?.classList.remove('visible');
                console.log('[WebARSession] Session started');
            });

            this.renderer.xr.addEventListener('sessionend', () => {
                this.isARActive = false;
                this.reticle.visible = false;
                document.getElementById('ar-badge')?.classList.remove('visible');
                document.getElementById('ar-button')?.classList.add('visible');
                console.log('[WebARSession] Session ended');
            });

            return true;
        } catch (err) {
            console.error('[WebARSession] Init failed:', err);
            return false;
        }
    }

    /** Программно нажать скрытую AR-кнопку Three.js */
    triggerAREntry(): void {
        this._arButtonEl?.click();
    }

    animate(callback: (time: number, frame?: XRFrame) => void): void {
        this.renderer.setAnimationLoop((time, frame) => {
            callback(time, frame ?? undefined);
            this.renderer.render(this.scene, this.camera);
        });
    }

    private _onResize(): void {
        const w = window.innerWidth;
        const h = window.innerHeight;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
    }

    dispose(): void {
        this.renderer.setAnimationLoop(null);
        this.renderer.dispose();
    }
}
