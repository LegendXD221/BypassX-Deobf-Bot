const { TextDecoder } = require("util");

function decodeBufferUtf8OrLatin1(buffer) {
  const valueBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    return { value: decoder.decode(valueBuffer), byteMode: false };
  } catch {
    return { value: valueBuffer.toString("latin1"), byteMode: true };
  }
}

module.exports = {
  decodeBufferUtf8OrLatin1,
};