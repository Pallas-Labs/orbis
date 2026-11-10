import { mock } from "bun:test";

export interface ToastSnapshot {
  readonly message: string | undefined;
  readonly style: string | undefined;
  readonly title: string | undefined;
}

export interface Tab {
  readonly active: boolean;
  readonly title?: string;
  readonly url: string;
}

export interface RaycastPreferences {
  readonly deviceToken?: string;
  readonly serviceUrl: string;
}

/** Raycast's `environment`. Vicinae, which runs Raycast extensions, adds `vicinaeVersion`. */
export interface RaycastEnvironment {
  vicinaeVersion?: { readonly commit: string; readonly tag: string };
}

export interface RaycastState {
  clipboard: string | undefined;
  environment: RaycastEnvironment;
  /** The `<title>` of the active tab in the focused window, as `getContent` reads it. */
  focusedTitle: string | undefined;
  getTabsError: Error | null;
  /** The text of each `showHUD` call, in order. */
  huds: string[];
  preferences: RaycastPreferences;
  snapshots: ToastSnapshot[];
  storage: Map<string, string>;
  tabs: Tab[];
}

export const raycast: RaycastState = {
  clipboard: undefined,
  environment: {},
  focusedTitle: undefined,
  getTabsError: null,
  huds: [],
  preferences: {
    deviceToken: "device-token",
    serviceUrl: "https://orbis.test",
  },
  snapshots: [],
  storage: new Map(),
  tabs: [],
};

const inVicinae = () => "vicinaeVersion" in raycast.environment;

/**
 * A stand-in for a Raycast Toast that records a snapshot on every property change, so a
 * test can see the progress state and the final state the user would have seen. Vicinae's
 * Toast resends itself only when its style or title changes, so in Vicinae a message change
 * alone records nothing.
 */
class RecordedToast {
  readonly #resendsOnMessage = !inVicinae();
  readonly #snapshots: ToastSnapshot[];
  #message: string | undefined;
  #style: string | undefined;
  #title: string | undefined;

  constructor(snapshots: ToastSnapshot[], options: ToastSnapshot) {
    this.#snapshots = snapshots;
    this.#message = options.message;
    this.#style = options.style;
    this.#title = options.title;
    this.#record();
  }

  get message(): string | undefined {
    return this.#message;
  }

  set message(value: string | undefined) {
    this.#message = value;
    if (this.#resendsOnMessage) {
      this.#record();
    }
  }

  get style(): string | undefined {
    return this.#style;
  }

  set style(value: string | undefined) {
    this.#style = value;
    this.#record();
  }

  get title(): string | undefined {
    return this.#title;
  }

  set title(value: string | undefined) {
    this.#title = value;
    this.#record();
  }

  #record() {
    this.#snapshots.push({
      message: this.#message,
      style: this.#style,
      title: this.#title,
    });
  }
}

const trackToast = (options: ToastSnapshot) =>
  new RecordedToast(raycast.snapshots, options);

/**
 * Replaces the Raycast module with the smallest surface the commands use, recording every
 * toast state so a test can assert what the user would see. Call before importing a command.
 */
export const installRaycastApi = () => {
  void mock.module("@raycast/api", () => ({
    BrowserExtension: {
      getContent: () =>
        raycast.focusedTitle === undefined
          ? Promise.reject(new Error("No focused tab"))
          : Promise.resolve(raycast.focusedTitle),
      getTabs: () =>
        raycast.getTabsError
          ? Promise.reject(raycast.getTabsError)
          : Promise.resolve(raycast.tabs),
    },
    Clipboard: {
      readText: () => Promise.resolve(raycast.clipboard),
    },
    LocalStorage: {
      getItem: (key: string) => Promise.resolve(raycast.storage.get(key)),
      setItem: (key: string, value: string) => {
        raycast.storage.set(key, value);
        return Promise.resolve();
      },
    },
    Toast: {
      Style: { Animated: "animated", Failure: "failure", Success: "success" },
    },
    environment: raycast.environment,
    getPreferenceValues: () => raycast.preferences,
    showHUD: (title: string) => {
      raycast.huds.push(title);
      return Promise.resolve();
    },
    showToast: (options: ToastSnapshot) => Promise.resolve(trackToast(options)),
  }));
};

/** Runs the commands as Vicinae would, with its marker on `environment`. */
export const useVicinae = () => {
  raycast.environment.vicinaeVersion = { commit: "68847f4b7", tag: "v0.29.0" };
};

export const resetRaycast = () => {
  raycast.clipboard = undefined;
  delete raycast.environment.vicinaeVersion;
  raycast.focusedTitle = undefined;
  raycast.getTabsError = null;
  raycast.huds.length = 0;
  raycast.preferences = {
    deviceToken: "device-token",
    serviceUrl: "https://orbis.test",
  };
  raycast.snapshots.length = 0;
  raycast.storage.clear();
  raycast.tabs = [];
};

export const finalToast = (): ToastSnapshot | undefined =>
  raycast.snapshots.at(-1);
