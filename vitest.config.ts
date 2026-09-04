import { defineConfig } from 'vitest/config';

// Node environment throughout: there is no DOM here and nothing to render.
// The one thing worth saying is why these tests need no MIDI hardware and no
// build toolchain - `ports.ts` takes its backend as an argument, so every test
// hands in a fake and the native module is never loaded.
export default defineConfig({
    test: {
        environment: 'node',
        include: ['test/**/*.test.ts'],
    },
});
