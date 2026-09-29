// V8.0 密码哈希共享实现（PBKDF2-SHA256 / 100,000 轮）
// 与历史登录逻辑完全一致，保证已有密码继续可校验

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return 'pbkdf2$100000$' +
    Array.from(salt, b => b.toString(16).padStart(2, '0')).join('') + '$' +
    Array.from(new Uint8Array(derivedBits), b => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('pbkdf2$')) {
    return password === stored;
  }
  const parts = stored.split('$');
  const iterations = parseInt(parts[1]);
  const salt = new Uint8Array(parts[2].match(/.{2}/g).map(b => parseInt(b, 16)));
  const storedHash = parts[3];
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const computedHash = Array.from(new Uint8Array(derivedBits), b => b.toString(16).padStart(2, '0')).join('');
  // 恒定时间比较，防止时序侧信道泄露哈希前缀
  if (computedHash.length !== storedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < computedHash.length; i++) {
    diff |= computedHash.charCodeAt(i) ^ storedHash.charCodeAt(i);
  }
  return diff === 0;
}
