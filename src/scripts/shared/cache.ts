export function getCache(name: string): Promise<Cache> {
    return caches.open(name)
}
