import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
    plugins: [basicSsl()],
    build: {
        target: 'esnext',
        sourcemap: true
    },
    server: {
        https: true,
        host: '0.0.0.0',
        port: 3000
    }
});
