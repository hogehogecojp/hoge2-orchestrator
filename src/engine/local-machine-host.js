import { networkInterfaces } from 'os';

export function normalizeHostForLocalComparison(host) {
  let normalized = String(host ?? '').trim().toLowerCase();
  normalized = normalized.replace(/^\[|\]$/g, '');
  const zoneIndex = normalized.indexOf('%');
  if (zoneIndex !== -1) {
    normalized = normalized.slice(0, zoneIndex);
  }
  return normalized;
}

export function collectLocalMachineAddresses() {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .map((entry) => entry?.address)
    .filter((address) => typeof address === 'string' && address.trim() !== '');
}

export function isLoopbackHost(host) {
  const normalized = normalizeHostForLocalComparison(host);
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

export function isLocalMachineHost(host, localAddresses = collectLocalMachineAddresses()) {
  const normalized = normalizeHostForLocalComparison(host);
  if (normalized === '') return false;
  if (isLoopbackHost(normalized)) return true;

  const normalizedLocalAddresses = new Set(
    (localAddresses ?? [])
      .map((address) => normalizeHostForLocalComparison(address))
      .filter((address) => address !== ''),
  );
  return normalizedLocalAddresses.has(normalized);
}
