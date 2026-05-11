const MAX_ACTIVITY_EVENTS = 120;

export function createActivityStore() {
  const sessions = new Map();

  return {
    start(requestId) {
      if (!requestId) return;
      sessions.set(requestId, {
        requestId,
        startedAt: new Date().toISOString(),
        finished: false,
        events: [],
      });
    },

    emit(requestId, event) {
      if (!requestId) return;
      if (!sessions.has(requestId)) {
        this.start(requestId);
      }

      const session = sessions.get(requestId);
      const item = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        at: new Date().toISOString(),
        type: event.type || "info",
        message: scrubActivityMessage(event.message || ""),
        detail: scrubActivityMessage(event.detail || ""),
      };

      session.events.push(item);
      if (session.events.length > MAX_ACTIVITY_EVENTS) {
        session.events.splice(0, session.events.length - MAX_ACTIVITY_EVENTS);
      }
    },

    finish(requestId) {
      const session = sessions.get(requestId);
      if (!session) return;
      session.finished = true;
      session.finishedAt = new Date().toISOString();
    },

    get(requestId) {
      return sessions.get(requestId) || {
        requestId,
        startedAt: "",
        finished: true,
        events: [],
      };
    },

    cleanup(maxAgeMs = 30 * 60 * 1000) {
      const now = Date.now();
      for (const [requestId, session] of sessions.entries()) {
        const referenceTime = Date.parse(session.finishedAt || session.startedAt || "");
        if (referenceTime && now - referenceTime > maxAgeMs) {
          sessions.delete(requestId);
        }
      }
    },
  };
}

export function createActivityEmitter(store, requestId) {
  return (type, message, detail = "") => {
    store.emit(requestId, { type, message, detail });
  };
}

export function emitActivity(activity, type, message, detail = "") {
  if (typeof activity === "function") {
    activity(type, message, detail);
  }
}

function scrubActivityMessage(value) {
  return String(value || "")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .slice(0, 500);
}
