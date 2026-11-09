function looksObfuscated(source) {
  const text = typeof source === "string" ? source : "";
  const singleLetterIndexCount = (text.match(/\b[a-zA-Z]\[[^\]]+\]/g) || []).length;

  return (
    /\b[A-Za-z_][A-Za-z0-9_]*\(\d{6,}, \{/.test(text) ||
    /\blocal_\d+\b/.test(text) ||
    /\bTamper Detected!\b/.test(text) ||
    /\bg\[[^\]]+\]/.test(text) ||
    /\bO\[[^\]]+\]/.test(text) ||
    singleLetterIndexCount >= 4
  );
}

module.exports = {
  looksObfuscated,
};