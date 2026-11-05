const crypto = require('node:crypto');
const fs = require('node:fs');

const MODES = new Set(['read-only', 'full-access']);

const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');

const openCredentialStore = filePath => {
  const read = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return Array.isArray(parsed.credentials) ? parsed.credentials : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  const write = credentials => {
    fs.writeFileSync(filePath, JSON.stringify({ credentials }), { mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch { /* windows may ignore the mode */ }
  };
  if (read().length === 0) {
    const token = crypto.randomBytes(32).toString('base64url');
    write([{
      id: crypto.randomUUID(),
      name: 'local',
      mode: 'full-access',
      tokenHash: hashToken(token),
      token,
      createdAt: Date.now(),
    }]);
  }
  return {
    list: () => read().map(({ id, name, mode, createdAt }) => ({ id, name, mode, createdAt })),
    verify: token => {
      if (typeof token !== 'string' || token.length < 20) return null;
      const digest = hashToken(token);
      const found = read().find(item => item.tokenHash.length === digest.length
        && crypto.timingSafeEqual(Buffer.from(item.tokenHash), Buffer.from(digest)));
      return found ? { id: found.id, name: found.name, mode: found.mode } : null;
    },
    reveal: id => {
      const found = read().find(item => item.id === id);
      return found ? { id: found.id, name: found.name, mode: found.mode, token: found.token } : null;
    },
    create: ({ name, mode }) => {
      const credentials = read();
      if (credentials.length >= 16) throw new Error('credential limit is 16');
      if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 40) {
        throw new Error('credential name must be 1 to 40 characters');
      }
      if (!MODES.has(mode)) throw new Error('credential mode must be read-only or full-access');
      const token = crypto.randomBytes(32).toString('base64url');
      const entry = {
        id: crypto.randomUUID(),
        name: name.trim(),
        mode,
        tokenHash: hashToken(token),
        token,
        createdAt: Date.now(),
      };
      write([...credentials, entry]);
      return { id: entry.id, name: entry.name, mode: entry.mode, token };
    },
    revoke: id => {
      const credentials = read();
      if (credentials.length <= 1) throw new Error('the last credential cannot be revoked');
      const next = credentials.filter(item => item.id !== id);
      if (next.length === credentials.length) throw new Error('unknown credential');
      write(next);
    },
  };
};

module.exports = { openCredentialStore };
