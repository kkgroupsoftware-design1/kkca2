/** In-memory presence: userId -> set of socket ids (a user may have several devices). */
const socketsByUser = new Map<string, Set<string>>();

export function addPresence(userId: string, socketId: string): void {
  let set = socketsByUser.get(userId);
  if (!set) {
    set = new Set();
    socketsByUser.set(userId, set);
  }
  set.add(socketId);
}

export function removePresence(userId: string, socketId: string): boolean {
  const set = socketsByUser.get(userId);
  if (!set) return false;
  set.delete(socketId);
  if (set.size === 0) {
    socketsByUser.delete(userId);
    return true; // user fully offline now
  }
  return false;
}

export function isOnline(userId: string): boolean {
  return socketsByUser.has(userId);
}

export function onlineUserIds(): string[] {
  return [...socketsByUser.keys()];
}

export function clearPresenceForTests(): void {
  socketsByUser.clear();
}
