export class LruMemoryCache<K, V> {
    private readonly map = new Map<K, V>();

    constructor(public readonly capacity: number = 50) {
        if (capacity <= 0) {
            throw new Error('LruMemoryCache capacity must be greater than 0');
        }
    }

    get(key: K): V | undefined {
        if (!this.map.has(key)) {
            return undefined;
        }
        const val = this.map.get(key)!;
        // Refresh insertion order to mark most recently used
        this.map.delete(key);
        this.map.set(key, val);
        return val;
    }

    set(key: K, value: V): void {
        if (this.map.has(key)) {
            this.map.delete(key);
        } else if (this.map.size >= this.capacity) {
            // Evict least recently used (first entry in Map)
            const oldestKey = this.map.keys().next().value;
            if (oldestKey !== undefined) {
                this.map.delete(oldestKey);
            }
        }
        this.map.set(key, value);
    }

    has(key: K): boolean {
        return this.map.has(key);
    }

    clear(): void {
        this.map.clear();
    }

    get size(): number {
        return this.map.size;
    }
}
