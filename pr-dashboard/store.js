import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function createDoneStore({ file = null, logger }) {
  let entries = {};

  if (file) {
    try {
      entries = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') logger.error('could not read done flags, starting empty', { file, error });
    }
  }

  function persist(next) {
    if (file) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(next));
      renameSync(`${file}.tmp`, file);
    }
    entries = next;
  }

  return {
    all: () => entries,
    set(url, entry) {
      persist({ ...entries, [url]: entry });
    },
    delete(url) {
      if (!(url in entries)) return;
      const { [url]: _, ...rest } = entries;
      persist(rest);
    },
    retain(keep) {
      const kept = Object.fromEntries(Object.entries(entries).filter(([url, entry]) => keep(url, entry)));
      if (Object.keys(kept).length !== Object.keys(entries).length) persist(kept);
    },
  };
}

export { createDoneStore };
