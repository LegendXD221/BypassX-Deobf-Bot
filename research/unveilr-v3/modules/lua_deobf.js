const beautify = require("./lua_beautifier")
const parse = require("luaparse").parse

const print = console.log

const fs = require("fs").promises

function LUA_TO_JS(luaStr) {
    return luaStr.replace(/\\(\d{1,3})/g, (_, n) =>
        String.fromCharCode(Number(n))
    );
}

function DECRYPT_STR_0(str, key) {
    const result = [];

    for (let i = 0; i < str.length; i++) {
        const strByte = str.charCodeAt(i);

        const keyIndex = (i + 1) % key.length; // Lua: 1 + (i % #key)
        const keyByte = key.charCodeAt(keyIndex);

        const decryptedChar =
            String.fromCharCode((strByte ^ keyByte) % 256);

        result.push(decryptedChar);
    }

    return result.join("");
}

const deobf = (src) => {
    // `v8` is the decryption function.

    const ast = parse(src)
    const parsed = ast.body

    let string_count = 0
    let decryptor;

    for (let i = 0; i < 8; i++) {
        const f = parsed[i]
        if (f.type == "FunctionDeclaration" && f.isLocal && f.body[0].type == "LocalStatement") {
            // decryption func!
            decryptor = f.identifier.name
        }
    }

    if (!decryptor) throw new Error("Unable to find the decryptor function.")

    const each = (node) => {
        if (Array.isArray(node)) return node.map(each);
        if (!node || typeof node !== "object" || !node.type) return node;
        if (node.type === "CallStatement") {
            node.expression = each(node.expression);
            return node;
        }

        if (node.type === "CallExpression") {
            node.base = each(node.base);
            node.arguments = each(node.arguments);

            if (node.base?.name === decryptor) {
                const [baseArg, keyArg] = node.arguments;
                const decrypted = DECRYPT_STR_0(
                    LUA_TO_JS(baseArg.value),
                    LUA_TO_JS(keyArg.value)
                );
                string_count++;
                return {
                    type: "StringLiteral",
                    raw: `'${decrypted}'`
                };
            }

            return node;
        }

        if (node.type === "MemberExpression") {
            node.base = each(node.base);
            node.identifier = each(node.identifier);
            return node;
        }

        for (const key in node) {
            const value = node[key];
            if (Array.isArray(value) || (value && typeof value === "object" && value.type)) {
                node[key] = each(value);
            }
        }

        return node;
    };

    each(parsed)

    return beautify(ast);
}

module.exports = deobf