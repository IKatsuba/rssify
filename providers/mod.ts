import type { Provider } from '../lib/types.ts';
import { provider as claudeCodeProvider } from './blogs/claude-code.ts';
import { provider as cursorProvider } from './blogs/cursor.ts';

const providers = new Map<string, Provider>();

export function registerProvider(provider: Provider): void {
  const key = `${provider.namespace}/${provider.route}`;
  providers.set(key, provider);
}

export function getProvider(
  namespace: string,
  route: string,
): Provider | undefined {
  return providers.get(`${namespace}/${route}`);
}

export function getAllProviders(): Provider[] {
  return [...providers.values()];
}

// Register all providers
registerProvider(claudeCodeProvider);
registerProvider(cursorProvider);
