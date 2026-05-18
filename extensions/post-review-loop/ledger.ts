import type { BucketIItem, BucketIStatus, BucketIIItem, BucketIIStatus } from "./types.js";

export const ACTIONABLE_BUCKET_I_STATUSES = new Set<BucketIStatus>(["candidate", "accepted", "remaining"]);
export const UNRESOLVED_BUCKET_II_STATUSES = new Set<BucketIIStatus>(["left for user decision", "deferred", "kept as-is for now"]);

function normalizedTextKey(value: string): string {
	return value.trim().replace(/\s+/g, " ").toLowerCase();
}

// V1 has no stable Bucket I finding id. Visible current views approximate
// identity by normalized title while the persisted ledger remains append-only
// audit history.
function normalizedBucketIKey(item: BucketIItem): string {
	return normalizedTextKey(item.title);
}

function bucketIIIdentity(item: BucketIIItem): string {
	return normalizedTextKey(item.title);
}

export function isActionableBucketI(item: BucketIItem): boolean {
	return ACTIONABLE_BUCKET_I_STATUSES.has(item.status);
}

export function isUnresolvedBucketII(item: BucketIIItem): boolean {
	return UNRESOLVED_BUCKET_II_STATUSES.has(item.status);
}

export function currentBucketIItems(items: BucketIItem[]): BucketIItem[] {
	const byKey = new Map<string, BucketIItem>();
	for (const item of items) {
		const key = normalizedBucketIKey(item);
		byKey.delete(key);
		byKey.set(key, item);
	}
	return Array.from(byKey.values());
}

export function countCurrentActionableBucketI(items: BucketIItem[]): number {
	return currentBucketIItems(items).filter(isActionableBucketI).length;
}

export function currentBucketIIItems(items: BucketIIItem[]): BucketIIItem[] {
	const byKey = new Map<string, BucketIIItem>();
	for (const item of items) {
		const key = bucketIIIdentity(item);
		if (!key) continue;
		byKey.set(key, item);
	}
	return Array.from(byKey.values());
}

export function countCurrentUnresolvedBucketII(items: BucketIIItem[]): number {
	return currentBucketIIItems(items).filter(isUnresolvedBucketII).length;
}

export function mergeBucketIIItems(existing: BucketIIItem[], updates: BucketIIItem[]): BucketIIItem[] {
	return currentBucketIIItems([...existing, ...updates]);
}
