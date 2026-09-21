import fs from 'node:fs/promises';
import path from 'node:path';

export class JsonStore {
  constructor(file) {
    this.file = file;
    this.state = { jobs: [], library: [] };
    this.writeChain = Promise.resolve();
  }

  async load() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.state.jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
      this.state.library = Array.isArray(parsed.library) ? parsed.library : [];
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      await this.save();
    }
    return this.state;
  }

  save() {
    this.writeChain = this.writeChain.then(async () => {
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.state, null, 2));
      await fs.rename(tmp, this.file);
    });
    return this.writeChain;
  }
}
