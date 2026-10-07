import { LocalStorage } from "@raycast/api";

/** Terminal sizes the zoom actions step through. More columns = smaller text in Raycast's detail pane. */
export const SIZES = [
  { cols: 64, rows: 24 },
  { cols: 80, rows: 28 },
  { cols: 100, rows: 34 },
  { cols: 120, rows: 40 },
] as const;
export const DEFAULT_SIZE_INDEX = 1;

const SIZE_KEY = "terminal.sizeIndex";
const LIVE_KEY = "terminal.live";

export async function loadSizeIndex(): Promise<number> {
  const value = Number(await LocalStorage.getItem<string>(SIZE_KEY));
  return Number.isInteger(value) && value >= 0 && value < SIZES.length ? value : DEFAULT_SIZE_INDEX;
}

export async function saveSizeIndex(index: number): Promise<void> {
  await LocalStorage.setItem(SIZE_KEY, String(index));
}

export async function loadLive(): Promise<boolean> {
  return (await LocalStorage.getItem<string>(LIVE_KEY)) === "1";
}

export async function saveLive(live: boolean): Promise<void> {
  await LocalStorage.setItem(LIVE_KEY, live ? "1" : "0");
}
