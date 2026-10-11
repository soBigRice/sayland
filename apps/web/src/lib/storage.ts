const DB_NAME = 'sayland-workshop';
const STORE = 'projects';
export async function withStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onerror = () => reject(new Error('浏览器无法打开作品存储，请导出作品以免丢失。'));
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction(STORE, mode);
      const request = operation(transaction.objectStore(STORE));
      transaction.oncomplete = () => { db.close(); resolve(request.result); };
      transaction.onerror = () => { db.close(); reject(new Error('作品没有保存成功，请检查浏览器空间或导出备份。')); };
      transaction.onabort = () => { db.close(); reject(new Error('保存中断了，请再保存一次。')); };
    };
  });
}
export const loadProject = () => withStore<unknown>('readonly', store => store.get('current'));
export const saveProject = (value: unknown) => withStore('readwrite', store => store.put(value, 'current'));
