const fs = require("fs");
const path = require("path");

function resolveInputPath(inputPath) {
  const absolutePath = path.resolve(process.cwd(), inputPath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Input file not found: ${absolutePath}`);
  }

  const stats = fs.statSync(absolutePath);
  if (!stats.isFile()) {
    throw new Error(`Input path must be a file: ${absolutePath}`);
  }

  return absolutePath;
}

function createDefaultFileName(inputPath) {
  const parsed = path.parse(inputPath);
  return `${parsed.name}.deobfuscated.lua`;
}

function isDirectoryLike(outputPath) {
  if (!outputPath) {
    return false;
  }

  if (outputPath.endsWith(path.sep) || outputPath.endsWith("/") || outputPath.endsWith("\\")) {
    return true;
  }

  if (!fs.existsSync(outputPath)) {
    return false;
  }

  return fs.statSync(outputPath).isDirectory();
}

function resolveOutputPath(inputPath, outputPath) {
  const fileName = createDefaultFileName(inputPath);

  if (!outputPath) {
    return path.join(process.cwd(), fileName);
  }

  const rawDirectoryLike =
    outputPath.endsWith(path.sep) || outputPath.endsWith("/") || outputPath.endsWith("\\");
  const absoluteOutput = path.resolve(process.cwd(), outputPath);
  const hasExtension = path.extname(outputPath) !== "";
  if (rawDirectoryLike || isDirectoryLike(absoluteOutput) || (!fs.existsSync(absoluteOutput) && !hasExtension)) {
    return path.join(absoluteOutput, fileName);
  }

  return absoluteOutput;
}

function ensureParentDirectory(filePath) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
}

module.exports = {
  ensureParentDirectory,
  resolveInputPath,
  resolveOutputPath,
};