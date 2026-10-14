const DB = "mars-fan-scout-native-v1";
export type SavedSession = { run?: { id: string }; source?: { id: string }; [key: string]: unknown };

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("records");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function saveSession(value: SavedSession): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("records", "readwrite");
      transaction.objectStore("records").put(value, "session");
      if (value.run?.id)
        transaction.objectStore("records").put(value, `run:${value.run.id}`);
      if (value.source?.id)
        transaction
          .objectStore("records")
          .put(value, `source:${value.source.id}`);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
export async function loadSession(sourceId?: string): Promise<SavedSession | undefined> {
  const db = await open();
  try {
    return await new Promise<SavedSession | undefined>((resolve, reject) => {
      const request = db
        .transaction("records")
        .objectStore("records")
        .get(sourceId ? `source:${sourceId}` : "session");
      request.onsuccess = () => resolve(request.result as SavedSession | undefined);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
