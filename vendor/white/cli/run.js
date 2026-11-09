const fs = require("fs");

const { parseArgs } = require("./args");
const { ensureParentDirectory, resolveInputPath, resolveOutputPath } = require("./paths");
const { deobfuscateSourceDetailed } = require("../passes/pipeline");

async function runCli() {
  const { inputPath, outputPath, debug } = parseArgs(process.argv.slice(2));
  const resolvedInput = resolveInputPath(inputPath);
  const resolvedOutput = resolveOutputPath(resolvedInput, outputPath);

  const source = fs.readFileSync(resolvedInput, "utf8");
  const result = deobfuscateSourceDetailed(source, {
    inputPath: resolvedInput,
    debug,
  });

  ensureParentDirectory(resolvedOutput);
  fs.writeFileSync(resolvedOutput, result.output, "utf8");

  process.stdout.write(`${resolvedOutput}\n`);
}

module.exports = {
  runCli,
};