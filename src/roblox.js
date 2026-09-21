import fs from 'node:fs/promises';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function creatorContext(type, id) {
  if (!id) throw new Error('ROBLOX_CREATOR_ID is missing.');
  if (String(type).toLowerCase() === 'user') return { userId: String(id) };
  return { groupId: String(id) };
}

function extractOperationId(value) {
  if (!value) return null;
  const s = String(value);
  const m = s.match(/operations\/([^/?#]+)/i);
  return m ? m[1] : s;
}

export class RobloxClient {
  constructor(env) {
    this.key = env.ROBLOX_API_KEY || '';
    this.creatorType = env.ROBLOX_CREATOR_TYPE || 'group';
    this.creatorId = env.ROBLOX_CREATOR_ID || '';
    this.uploadUrl = env.ROBLOX_UPLOAD_URL || 'https://apis.roblox.com/assets/v1/assets';
    this.operationBase = (env.ROBLOX_OPERATION_BASE_URL || 'https://apis.roblox.com/assets/v1/operations').replace(/\/$/, '');
    this.simulate = String(env.SIMULATE_ROBLOX || '').toLowerCase() === 'true';
  }

  get configured() { return this.simulate || Boolean(this.key && this.creatorId && this.uploadUrl); }

  async uploadAudio(file, displayName, partIndex = 1) {
    if (this.simulate) {
      await sleep(500);
      return { assetId: String(Math.floor(100000000000000 + Math.random() * 899999999999999)), simulated: true };
    }
    if (!this.key) throw new Error('ROBLOX_API_KEY is missing.');

    const bytes = await fs.readFile(file);
    const request = {
      assetType: 'Audio',
      displayName: partIndex > 1 ? `${displayName} (${partIndex})` : displayName,
      description: 'Uploaded by Casa Nocturna Music Desk',
      creationContext: { creator: creatorContext(this.creatorType, this.creatorId) }
    };
    const form = new FormData();
    form.append('request', JSON.stringify(request));
    form.append('fileContent', new Blob([bytes], { type: 'audio/mpeg' }), `audio-${partIndex}.mp3`);

    const res = await fetch(this.uploadUrl, { method: 'POST', headers: { 'x-api-key': this.key }, body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || data?.error || `Roblox upload failed (${res.status}).`);

    if (data?.response?.assetId || data?.assetId) return { assetId: String(data.response?.assetId || data.assetId), raw: data };
    const opId = extractOperationId(data?.path || data?.operationId || data?.name);
    if (!opId) throw new Error('Roblox accepted the upload but returned an unrecognized operation response. Check ROBLOX_* API settings against current Open Cloud docs.');
    return this.waitForOperation(opId);
  }

  async waitForOperation(operationId) {
    for (let attempt = 0; attempt < 90; attempt++) {
      const res = await fetch(`${this.operationBase}/${encodeURIComponent(operationId)}`, { headers: { 'x-api-key': this.key } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || data?.error || `Roblox operation check failed (${res.status}).`);
      const assetId = data?.response?.assetId || data?.assetId;
      if (data?.done && assetId) return { assetId: String(assetId), raw: data };
      if (data?.done && data?.error) throw new Error(data.error.message || 'Roblox asset operation failed.');
      await sleep(2000);
    }
    throw new Error('Timed out waiting for Roblox asset creation.');
  }
}
