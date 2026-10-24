/**
 * Lionscope insights: the pure, dependency-free figures the dashboard shows (screens, stalls, StrictMode,
 * layouts, frames, logcat filtering), shared with the server's agent tools so an AI sees the same numbers.
 * Like `../wire.ts`, nothing here may import zod or any other runtime dependency.
 */
export * from './frames.ts';
export * from './layouts.ts';
export * from './logs.ts';
export * from './network.ts';
export * from './origins.ts';
export * from './screens.ts';
export * from './stalls.ts';
