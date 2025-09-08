import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/test/**/*.spec.js'],
		coverage: {
			reporter: ['text', 'lcov'],
			provider: 'v8',
			lines: 90,
			functions: 90,
			statements: 90,
			branches: 90,
		},
	},
});


