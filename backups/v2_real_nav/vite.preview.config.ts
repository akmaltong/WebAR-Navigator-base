// Preview config: HTTP only (for Claude Code preview tool verification)
// For real AR testing on device, use the main vite.config.ts (HTTPS, port 3003)
import { defineConfig } from 'vite';

export default defineConfig({
    build: {
        target: 'esnext',
        sourcemap: true
    },
    server: {
        host: '127.0.0.1',
        port: 3001
    }
});
