function runRobloxRecoveryAst(ast, legacy) {
  if (!legacy || typeof legacy.recoverRobloxUiAssignmentsAst !== "function") {
    return {
      ast,
      changed: false,
    };
  }

  return legacy.recoverRobloxUiAssignmentsAst(ast);
}

module.exports = {
  runRobloxRecoveryAst,
};