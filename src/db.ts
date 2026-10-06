// Minimal IndexedDB wrapper. Everything stays on the device.
import type { Book } from "./book";
import type { CatalogueItem, ChatTurn, PendingBatch, SkillDraft } from "./types";

export interface BookState {
  id: string;
  chat: ChatTurn[];
  thesis: string;
  catalogue: CatalogueItem[];
  skill: SkillDraft | null;
  /** Economy-mode extraction waiting on the Batch API. */
  pendingBatch?: PendingBatch | null;
}

const DB_NAME = "skillbook";
const STORES = ["books", "state"] as const;
type Store = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx<T>(store: Store, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const listBooks = () => tx<Book[]>("books", "readonly", (s) => s.getAll());
export const getBook = (id: string) => tx<Book | undefined>("books", "readonly", (s) => s.get(id));
export const putBook = (book: Book) => tx("books", "readwrite", (s) => s.put(book));

export async function getState(id: string): Promise<BookState> {
  return (await tx<BookState | undefined>("state", "readonly", (s) => s.get(id))) ?? { id, chat: [], thesis: "", catalogue: [], skill: null };
}
export const putState = (state: BookState) => tx("state", "readwrite", (s) => s.put(state));

export async function deleteBook(id: string): Promise<void> {
  await tx("books", "readwrite", (s) => s.delete(id));
  await tx("state", "readwrite", (s) => s.delete(id));
}
