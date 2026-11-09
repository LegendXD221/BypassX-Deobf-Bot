function parseArgs(argv) {
  let inputPath;
  let outputPath;
  let debug = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--debug") {
      debug = true;
      continue;
    }

    if (token === "-i") {
      index += 1;
      if (index >= argv.length) {
        throw new Error("Missing value for -i");
      }
      inputPath = argv[index];
      continue;
    }

    if (token === "-o") {
      index += 1;
      if (index >= argv.length) {
        throw new Error("Missing value for -o");
      }
      outputPath = argv[index];
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  if (!inputPath) {
    throw new Error("Missing required -i <input.lua>");
  }

  return {
    inputPath,
    outputPath,
    debug,
  };
}

module.exports = {
  parseArgs,
};