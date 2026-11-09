function isNode(value) {
  return Boolean(value) && typeof value === "object" && typeof value.type === "string";
}

function cloneNode(node) {
  if (Array.isArray(node)) {
    return node.map(cloneNode);
  }

  if (!node || typeof node !== "object") {
    return node;
  }

  const clone = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "scope") {
      continue;
    }
    clone[key] = cloneNode(value);
  }
  return clone;
}

function walk(node, visitor, parent = null, key = null, index = -1) {
  if (!isNode(node)) {
    return;
  }

  visitor(node, parent, key, index);

  for (const [childKey, childValue] of Object.entries(node)) {
    if (Array.isArray(childValue)) {
      childValue.forEach((item, childIndex) => {
        walk(item, visitor, node, childKey, childIndex);
      });
      continue;
    }

    if (isNode(childValue)) {
      walk(childValue, visitor, node, childKey, -1);
    }
  }
}

function walkMut(node, visitor) {
  let root = node;

  const visit = (current, parent, key, index) => {
    if (!isNode(current)) {
      return;
    }

    let result = visitor(current, parent, key, index);
    if (result === undefined) {
      result = current;
    }

    let skipChildren = false;
    if (result && result._skipChildren) {
      skipChildren = true;
      result = result.node;
    }

    if (result && result !== current) {
      if (parent) {
        replaceNode(parent, key, index, result);
      } else {
        root = result;
      }
      current = result;
    }

    if (skipChildren || !isNode(current)) {
      return;
    }

    for (const [childKey, childValue] of Object.entries(current)) {
      if (childKey === "scope") {
        continue;
      }
      if (Array.isArray(childValue)) {
        childValue.forEach((item, childIndex) => {
          visit(item, current, childKey, childIndex);
        });
        continue;
      }

      if (isNode(childValue)) {
        visit(childValue, current, childKey, -1);
      }
    }
  };

  visit(root, null, null, -1);
  return root;
}

function replaceNode(parent, key, index, value) {
  if (!parent) {
    throw new Error("Cannot replace root node directly");
  }

  if (index >= 0) {
    parent[key][index] = value;
    return;
  }

  parent[key] = value;
}

module.exports = {
  cloneNode,
  isNode,
  replaceNode,
  walkMut,
  walk,
};