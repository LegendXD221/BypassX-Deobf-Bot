function transformNode(node, visitor, parent = null) {
  if (!node || typeof node !== "object") {
    return node;
  }

  const visited = visitor(node, parent);
  const current = visited && visited._skipChildren ? visited.node : visited;
  if (!current || typeof current !== "object" || (visited && visited._skipChildren)) {
    return current;
  }

  if (Array.isArray(current)) {
    let changed = false;
    const next = current.map((child) => {
      const transformed = transformNode(child, visitor, parent);
      if (transformed !== child) {
        changed = true;
      }
      return transformed;
    });
    return changed ? next : current;
  }

  let changed = false;
  const next = {};
  for (const [key, value] of Object.entries(current)) {
    const transformed = transformNode(value, visitor, current);
    if (transformed !== value) {
      changed = true;
    }
    next[key] = transformed;
  }

  return changed ? next : current;
}

module.exports = {
  transformNode,
};