/**
 * The 10-user cap as a pure, unit-testable rule.
 * Seed and any future provisioning path must go through these helpers —
 * there is deliberately no public registration endpoint.
 */
export function canInsertUser(currentActiveOrTotalCount: number, maxUsers = 10): boolean {
  if (!Number.isFinite(currentActiveOrTotalCount) || currentActiveOrTotalCount < 0) return false;
  return currentActiveOrTotalCount < maxUsers;
}

export function assertCanInsertUser(currentCount: number, maxUsers = 10): void {
  if (!canInsertUser(currentCount, maxUsers)) {
    throw new Error(`User limit reached: this team is capped at ${maxUsers} authorized accounts`);
  }
}

export function validateSeedList(usernames: string[], maxUsers = 10): void {
  if (usernames.length === 0) throw new Error('Seed list is empty');
  if (usernames.length > maxUsers) {
    throw new Error(`Seed list has ${usernames.length} users but the cap is ${maxUsers} — refusing to seed`);
  }
  const seen = new Set<string>();
  for (const u of usernames) {
    const key = u.trim().toLowerCase();
    if (!key) throw new Error('Seed list contains an empty username');
    if (seen.has(key)) throw new Error(`Duplicate username in seed list: ${u}`);
    seen.add(key);
  }
}
