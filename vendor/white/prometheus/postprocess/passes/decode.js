function deriveDecodeOptions() {
  return {
    workBudget: {
      decodeRounds: 2,
      foldRounds: 3,
      inlineRounds: 3,
    },
  };
}

module.exports = {
  deriveDecodeOptions,
};