import * as THREE from 'three';
import * as Comlink from 'comlink';

export class AprilTagTracker {
    private worker: Worker | null = null;
    private api: any = null;
    private isReady = false;
    private isScanning = false;
    private glFrameBuffer: WebGLFramebuffer | null = null;
    private grayBuffer: Uint8Array | null = null;

    // Callbacks
    public onTagDetected?: (tag: any, arPos: THREE.Vector3, tagId: number) => void;

    /**
     * Инициализация
     */
    async init() {
        if (this.isReady) return;

        try {
            console.log('[AprilTagTracker] Включаем Worker...');
            this.worker = new Worker('/apriltag.js');
            const AprilTagAPI = Comlink.wrap(this.worker);

            // @ts-ignore
            this.api = await new AprilTagAPI(
                Comlink.proxy(() => {
                    console.log('[AprilTagTracker] Детектор готов!');
                    this.isReady = true;
                    // Укажем, для каких меток будем сканировать
                    this.api.set_max_detections(5);
                    this.api.set_return_pose(0); // Оставим 0 для скорости, если нам нужен только ID
                    this.api.set_return_solutions(0);
                    // Укажем реальный размер метки в метрах
                    this.api.set_tag_size(0, 0.15);
                })
            );
        } catch (error) {
            console.error('[AprilTagTracker] Ошибка инициализации:', error);
        }
    }

    /**
     * Попытаться считать кадр из WebXR камеры и найти там метки
     */
    async processFrame(session: XRSession, frame: XRFrame, gl: WebGL2RenderingContext | WebGLRenderingContext, refSpace: XRReferenceSpace) {
        if (!this.isReady || this.isScanning) return;

        // @ts-ignore - WebGLBinding may not be typed
        if (typeof XRWebGLBinding === 'undefined') return;

        const viewerPose = frame.getViewerPose(refSpace);
        if (!viewerPose) return;

        // Берем первую (или единственную) камеру
        const view = viewerPose.views[0];
        // @ts-ignore
        if (!view || !view.camera) return;

        // @ts-ignore
        const camera = view.camera as any;

        try {
            this.isScanning = true;

            // @ts-ignore
            const glBinding = new XRWebGLBinding(session, gl);
            const cameraImage = (glBinding as any).getCameraImage(camera);

            const width = camera.width;
            const height = camera.height;

            if (!cameraImage || width === 0 || height === 0) {
                this.isScanning = false;
                return;
            }

            // Настроим камеру в AprilTag 
            // Получаем интринсики (фокусное расстояние) из projectionMatrix
            const proj = view.projectionMatrix;
            const fx = (proj[0] * width) / 2;
            const fy = (proj[5] * height) / 2;
            const cx = width / 2;
            const cy = height / 2;
            this.api.set_camera_info(fx, fy, cx, cy);

            // Читаем пиксели из WebGLTexture
            if (!this.glFrameBuffer) {
                this.glFrameBuffer = gl.createFramebuffer();
            }

            gl.bindFramebuffer(gl.FRAMEBUFFER, this.glFrameBuffer);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, cameraImage, 0);

            const pixels = new Uint8Array(width * height * 4);
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);

            // Конвертируем в Grayscale
            if (!this.grayBuffer || this.grayBuffer.length !== width * height) {
                this.grayBuffer = new Uint8Array(width * height);
            }

            const gray = this.grayBuffer;
            for (let i = 0, j = 0; i < pixels.length; i += 4, j++) {
                gray[j] = (pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114) | 0;
            }

            // Отправляем в воркер
            const detections = await this.api.detect(gray, width, height);

            if (detections && detections.length > 0 && this.onTagDetected) {
                for (const det of detections) {
                    // Конвертация позы, если нужно, или просто передаем данные
                    // А пока мы используем AR позицию где находится телефон в данный момент 
                    // как приблизительное местоположение (для простого применения).
                    // Либо высчитать точную позицию метки в 3D

                    const camPos = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(viewerPose.transform.matrix));
                    this.onTagDetected(det, camPos, det.id);
                }
            }
        } catch (e) {
            // Ошибка обычно из-за того, что getCameraImage недоступен (camera-access permission)
            // Игнорируем или логируем один раз
        } finally {
            this.isScanning = false;
        }
    }

    dispose() {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
    }
}
