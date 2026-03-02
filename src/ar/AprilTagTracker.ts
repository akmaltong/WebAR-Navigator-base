import * as THREE from 'three';
import * as Comlink from 'comlink';

export class AprilTagTracker {
    private worker: Worker | null = null;
    private api: any = null;
    private isReady = false;
    private isScanning = false;
    private glFrameBuffer: WebGLFramebuffer | null = null;
    private grayBuffer: Uint8Array | null = null;
    private pixelBuffer: Uint8Array | null = null;
    private glBinding: any = null;
    private lastScanTime: number = 0;

    // Callbacks
    public onTagDetected?: (tagId: number, worldPos: THREE.Vector3) => void;

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
                    this.api.set_return_pose(1); // Мы хотим получать 3D позу
                    this.api.set_return_solutions(0);
                    // Укажем реальный размер метки в метрах
                    this.api.set_tag_size(0, 0.15);
                })
            );
        } catch (error) {
            console.error('[AprilTagTracker] Ошибка инициализации:', error);
        }
    }

    private quadProgram: WebGLProgram | null = null;
    private quadBuffer: WebGLBuffer | null = null;
    private targetTexture: WebGLTexture | null = null;
    private posAttrLoc: number = 0;
    private texUniformLoc: WebGLUniformLocation | null = null;
    private renderWidth = 0;
    private renderHeight = 0;

    private _initWebGL(gl: WebGLRenderingContext | WebGL2RenderingContext, srcWidth: number, srcHeight: number) {
        if (this.quadProgram) return;

        // ЖЕСТКОЕ ограничение: 480 пикселей по ширине.
        // Если читать 1920x1080 через gl.readPixels, телефон зависает и WebXR крашится.
        let scale = 1.0;
        if (srcWidth > 480) {
            scale = 480 / srcWidth;
        }

        this.renderWidth = Math.floor(srcWidth * scale);
        this.renderHeight = Math.floor(srcHeight * scale);

        const vsSource = `
            attribute vec2 a_position;
            varying vec2 v_texcoord;
            void main() {
                gl_Position = vec4(a_position, 0.0, 1.0);
                v_texcoord = a_position * 0.5 + 0.5;
            }
        `;
        const fsSource = `
            precision mediump float;
            varying vec2 v_texcoord;
            uniform sampler2D u_camera;
            void main() {
                gl_FragColor = vec4(texture2D(u_camera, v_texcoord).rgb, 1.0);
            }
        `;

        const vs = gl.createShader(gl.VERTEX_SHADER)!;
        gl.shaderSource(vs, vsSource);
        gl.compileShader(vs);

        const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
        gl.shaderSource(fs, fsSource);
        gl.compileShader(fs);

        this.quadProgram = gl.createProgram()!;
        gl.attachShader(this.quadProgram, vs);
        gl.attachShader(this.quadProgram, fs);
        gl.linkProgram(this.quadProgram);

        this.posAttrLoc = gl.getAttribLocation(this.quadProgram, 'a_position');
        this.texUniformLoc = gl.getUniformLocation(this.quadProgram, 'u_camera');

        this.quadBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
            -1, -1,
            1, -1,
            -1, 1,
            1, 1,
        ]), gl.STATIC_DRAW);

        this.glFrameBuffer = gl.createFramebuffer();
        this.targetTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.targetTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.renderWidth, this.renderHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.glFrameBuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.targetTexture, 0);

        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    /**
     * Попытаться считать кадр из WebXR камеры и найти там метки
     */
    async processFrame(session: XRSession, frame: XRFrame, gl: WebGL2RenderingContext | WebGLRenderingContext, refSpace: XRReferenceSpace, renderer?: THREE.WebGLRenderer) {
        if (!this.isReady || this.isScanning) return;

        const now = performance.now();
        // Даем браузеру перевести дух (3 кадров в сек)
        if (now - this.lastScanTime < 333) return;
        this.lastScanTime = now;

        // @ts-ignore
        if (typeof XRWebGLBinding === 'undefined') return;

        const viewerPose = frame.getViewerPose(refSpace);
        if (!viewerPose) return;

        const view = viewerPose.views[0];
        // @ts-ignore
        if (!view || !view.camera) return;

        // @ts-ignore
        const camera = view.camera as any;

        try {
            this.isScanning = true;

            if (!this.glBinding) {
                // @ts-ignore
                this.glBinding = new XRWebGLBinding(session, gl);
            }
            const cameraImage = this.glBinding.getCameraImage(camera);

            const width = camera.width;
            const height = camera.height;

            if (!cameraImage || width === 0 || height === 0) {
                this.isScanning = false;
                return;
            }

            this._initWebGL(gl, width, height);

            const proj = view.projectionMatrix;
            const scaleX = this.renderWidth / width;
            const scaleY = this.renderHeight / height;

            const fx = ((proj[0] * width) / 2) * scaleX;
            const fy = ((proj[5] * height) / 2) * scaleY;
            const cx = (width / 2) * scaleX;
            const cy = (height / 2) * scaleY;
            this.api.set_camera_info(fx, fy, cx, cy);

            // СОХРАНЯЕМ СТЕЙТ WebGL, чтобы не сломать Three.js
            const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING);
            const prevProg = gl.getParameter(gl.CURRENT_PROGRAM);
            const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
            const prevActiveTex = gl.getParameter(gl.ACTIVE_TEXTURE);
            const prevViewport = gl.getParameter(gl.VIEWPORT);
            const prevArrayBuf = gl.getParameter(gl.ARRAY_BUFFER_BINDING);

            const prevDepthTest = gl.isEnabled(gl.DEPTH_TEST);
            const prevBlend = gl.isEnabled(gl.BLEND);
            const prevCull = gl.isEnabled(gl.CULL_FACE);

            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.BLEND);
            gl.disable(gl.CULL_FACE);
            gl.colorMask(true, true, true, true);

            gl.bindFramebuffer(gl.FRAMEBUFFER, this.glFrameBuffer);
            gl.viewport(0, 0, this.renderWidth, this.renderHeight);

            gl.useProgram(this.quadProgram);

            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, cameraImage);
            gl.uniform1i(this.texUniformLoc, 0);

            gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
            gl.enableVertexAttribArray(this.posAttrLoc);
            gl.vertexAttribPointer(this.posAttrLoc, 2, gl.FLOAT, false, 0, 0);

            // Рисуем камеру в уменьшенный буфер
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

            if (!this.pixelBuffer || this.pixelBuffer.length !== this.renderWidth * this.renderHeight * 4) {
                this.pixelBuffer = new Uint8Array(this.renderWidth * this.renderHeight * 4);
                this.grayBuffer = new Uint8Array(this.renderWidth * this.renderHeight);
            }

            const pixels = this.pixelBuffer;
            const gray = this.grayBuffer!;

            // Читаем гораздо меньше пикселей (работает очень быстро)
            gl.readPixels(0, 0, this.renderWidth, this.renderHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

            // ВОССТАНАВЛИВАЕМ СТЕЙТ WebGL для Three.js
            gl.disableVertexAttribArray(this.posAttrLoc);
            gl.bindBuffer(gl.ARRAY_BUFFER, prevArrayBuf);
            gl.activeTexture(prevActiveTex);
            gl.bindTexture(gl.TEXTURE_2D, prevTex);
            gl.useProgram(prevProg);
            gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
            gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);

            if (prevDepthTest) gl.enable(gl.DEPTH_TEST);
            if (prevBlend) gl.enable(gl.BLEND);
            if (prevCull) gl.enable(gl.CULL_FACE);

            if (renderer && renderer.state) {
                renderer.state.reset();
            }

            // Конвертация в ЧБ (RGB -> Grayscale)
            for (let i = 0, j = 0; i < pixels.length; i += 4, j++) {
                gray[j] = (pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114) | 0;
            }

            const detections = await this.api.detect(gray, this.renderWidth, this.renderHeight);

            if (detections && detections.length > 0 && this.onTagDetected) {
                for (const det of detections) {
                    if (det.pose && det.pose.t) {
                        const localPos = new THREE.Vector3(det.pose.t[0], -det.pose.t[1], -det.pose.t[2]);
                        const camMatrix = new THREE.Matrix4().fromArray(viewerPose.transform.matrix);
                        const worldPos = localPos.applyMatrix4(camMatrix);
                        this.onTagDetected(det.id, worldPos);
                    }
                }
            }
        } catch (e) {
            console.error('[AprilTagTracker] Error:', e);
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
