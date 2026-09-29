// V8.0 昵称规范化 - 单一来源
// 注册查重、name_norm 唯一索引、昵称登录必须使用完全一致的规范化，
// 否则会出现「注册成功但登录不上」的分裂。

// 昵称规范化：去除零宽字符、不可见字符，NFC 归一化，折叠空白，转小写
// 用于检测视觉上完全一致的昵称（防止用特殊字符达到重复效果）
export function normalizeName(name) {
  if (!name) return '';
  // 去除零宽字符和不可见字符：ZWSP, ZWNJ, ZWJ, BOM, WJ, soft hyphen, 方向控制符等
  let s = String(name).replace(/[\u200B\u200C\u200D\uFEFF\u2060\u00AD\u200E\u200F\u202A-\u202E\u2061-\u2064]/g, '');
  // NFC 归一化（合并组合字符序列）
  s = s.normalize('NFC');
  // 折叠所有空白（包括各种 Unicode 空格）为单个普通空格
  s = s.replace(/[\s\u00A0\u2000-\u200A\u202F\u205F\u3000]+/g, ' ');
  // 去除首尾空白
  s = s.trim();
  // 转小写用于比较
  return s.toLowerCase();
}
