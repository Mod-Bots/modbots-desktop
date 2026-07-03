// Local persistence for the chosen room identity: the actor id plus the
// session token when the backend issued one. Stored in localStorage so the
// identity survives app restarts.

const storageKey = "modbots.desktop.identity";

export interface StoredIdentity {
  actorId: string;
  token: string | null;
}

export const loadStoredIdentity = (): StoredIdentity | null => {
  try {
    const raw = window.localStorage.getItem(storageKey);

    if (raw === null) {
      return null;
    }

    const parsed = JSON.parse(raw) as { actorId?: unknown; token?: unknown };

    if (typeof parsed.actorId !== "string" || parsed.actorId.length === 0) {
      return null;
    }

    return {
      actorId: parsed.actorId,
      token: typeof parsed.token === "string" ? parsed.token : null,
    };
  } catch {
    return null;
  }
};

export const saveStoredIdentity = (identity: StoredIdentity): void => {
  window.localStorage.setItem(storageKey, JSON.stringify(identity));
};

export const clearStoredIdentity = (): void => {
  window.localStorage.removeItem(storageKey);
};
