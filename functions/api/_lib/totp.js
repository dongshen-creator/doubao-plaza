// V8.0 TOTP（RFC 6238：HMAC-SHA1 / 6 位 / 30 秒步长）
// 纯 WebCrypto 实现，无第三方依赖；密钥不出服务端处理链路（仅 setup 时返回给本人）

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const s = String(str).replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function hotp(keyBytes, counter, digits) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const offset = sig[sig.length - 1] & 0x0f;
  const code = (
    ((sig[offset] & 0x7f) << 24) |
    (sig[offset + 1] << 16) |
    (sig[offset + 2] << 8) |
    sig[offset + 3]
  ) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

// 生成 20 字节随机密钥（返回 Base32，无填充，兼容主流验证器）
export function generateTotpSecret() {
  const b = new Uint8Array(20);
  crypto.getRandomValues(b);
  return base32Encode(b);
}

// otpauth:// 深链（扫码导入用；密钥同样给出以便手动输入）
export function otpauthUri(secretB32, accountName, issuer = '逗包用户广场') {
  return 'otpauth://totp/' + encodeURIComponent(issuer) + ':' + encodeURIComponent(accountName) +
    '?secret=' + secretB32 +
    '&issuer=' + encodeURIComponent(issuer) +
    '&algorithm=SHA1&digits=6&period=30';
}

// 校验动态码：允许前后 1 个时间窗容差（±30 秒），恒定时间比较
export async function totpVerify(secretB32, code, window = 1) {
  if (!secretB32 || !code) return false;
  const c = String(code).replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  let key;
  try {
    key = base32Decode(secretB32);
  } catch {
    return false;
  }
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let w = -window; w <= window; w++) {
    const expected = await hotp(key, counter + w, 6);
    if (expected.length === c.length) {
      let diff = 0;
      for (let i = 0; i < expected.length; i++) {
        diff |= expected.charCodeAt(i) ^ c.charCodeAt(i);
      }
      if (diff === 0) return true;
    }
  }
  return false;
}
