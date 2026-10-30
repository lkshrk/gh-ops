import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function createDashboardStore({ file = null, logger }) {
  let state = { done: {}, watchlist: {} };

  if (file) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      state = 'done' in saved || 'watchlist' in saved
        ? { done: saved.done || {}, watchlist: saved.watchlist || {} }
        : { done: saved, watchlist: {} };
    } catch (error) {
      if (error.code !== 'ENOENT') logger.error('could not read dashboard state, starting empty', { file, error });
    }
  }

  function persist(next) {
    if (file) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(next));
      renameSync(`${file}.tmp`, file);
    }
    state = next;
  }

  function replace(section, entries) {
    persist({ ...state, [section]: entries });
  }

  function set(section, url, entry) {
    replace(section, { ...state[section], [url]: entry });
  }

  function deleteEntry(section, url) {
    if (!(url in state[section])) return;
    const { [url]: _, ...entries } = state[section];
    replace(section, entries);
  }

  return {
    doneAll: () => ({ ...state.done }),
    setDone(url, entry) {
      set('done', url, entry);
    },
    deleteDone(url) {
      deleteEntry('done', url);
    },
    retainDone(keep) {
      const entries = Object.fromEntries(Object.entries(state.done).filter(([url, entry]) => keep(url, entry)));
      if (Object.keys(entries).length !== Object.keys(state.done).length) replace('done', entries);
    },
    watchlistAll: () => ({ ...state.watchlist }),
    setWatch(url, entry) {
      set('watchlist', url, entry);
    },
    deleteWatch(url) {
      deleteEntry('watchlist', url);
    },
    replaceWatch(entries) {
      replace('watchlist', { ...entries });
    },
  };
}

export { createDashboardStore };
