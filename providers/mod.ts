import type { Provider } from "../lib/types.ts";

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

// Auto-import all providers
import "./blogs/claude-code.ts";
