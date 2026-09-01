const deleteIndexedDatabase = (name: string): Promise<void> => new Promise((resolve) => {
  const request = indexedDB.deleteDatabase(name);
  request.onsuccess = () => resolve();
  request.onerror = () => resolve();
  request.onblocked = () => resolve();
});

export const clearBrowserData = async (): Promise<void> => {
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  }
  if ('indexedDB' in window && typeof indexedDB.databases === 'function') {
    const databases = await indexedDB.databases();
    await Promise.all(databases
      .map((database) => database.name)
      .filter((name): name is string => name !== undefined)
      .map(deleteIndexedDatabase));
  }
  localStorage.clear();
  sessionStorage.clear();
  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  }
};
