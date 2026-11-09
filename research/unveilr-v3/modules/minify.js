const OPERATORS = new Set([" == ", " ~= ", " <= ", " >= ", " < ", " > ", " and ", "not ", " or "]);
const BRACKET_MAP = { "(": 1, "[": 1, "{": 1, ")": -1, "]": -1, "}": -1 };
const KEYWORDS = new Set(["local", "if", "then", "else", "elseif", "end", "do", "while", "for", "repeat", "until", "return", "function", "break", "in"]);
const WORD_BOUND = /[A-Za-z0-9_]/;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isOp = (s) => { for (const op of OPERATORS) if (s.includes(op)) return true; return false; };
const isNamecall = (s) => { const i = s.indexOf(":"); return i > 0 && /[\w.\[\]]/.test(s[i - 1]); };

const isCall = (code) => {
	const c0 = code[0];
	if (c0 === '"' || c0 === "'") return [false, false];
	if (isOp(code)) return [false, true];
	if (isNamecall(code)) return [true, false];
	code = code.replace(/\s*--[^\n]+/g, "");
	const p = code.indexOf("("), cl = code.indexOf(")", p);
	return [p >= 0 && cl >= 0 && cl >= code.length - 3, false];
};

const extractValue = (content, start) => {
	let i = start, depth = 0, inStr = null;
	while (i < content.length) {
		const c = content[i], c2 = content.slice(i, i + 2);
		if (inStr) {
			if (c === "\\" ) { i += 2; continue; }
			if (c === inStr) inStr = null;
			i++; continue;
		}
		if (c === '"' || c === "'") { inStr = c; i++; continue; }
		if (c2 === "--") break;
		if (BRACKET_MAP[c]) {
			depth += BRACKET_MAP[c];
			if (depth < 0) break;
			i++; continue;
		}
		if (depth === 0 && c === "\n") break;
		if (depth === 0) {
			const wordMatch = content.slice(i).match(/^([A-Za-z_]\w*)/);
			if (wordMatch && KEYWORDS.has(wordMatch[1]) && (i === start || !/[A-Za-z0-9_]/.test(content[i - 1]))) break;
		}
		i++;
	}
	return content.slice(start, i).trim();
};

const parseDecls = (content) => {
	const decls = [], re = /\blocal\s+([A-Za-z_]\w*)\s*=\s*/g;
	let m;
	while ((m = re.exec(content))) {
		const v = m[1], valStart = m.index + m[0].length;
		const val = extractValue(content, valStart);
		if (!val) continue;
		let depth = 0;
		for (const c of val) depth += BRACKET_MAP[c] || 0;
		if (depth !== 0) continue;
		decls.push({ v, val, full: m[0] + val, start: m.index, end: m.index + m[0].length + val.length });
	}
	return decls;
};

const countDecls = (content, v) => {
	const re = new RegExp("\\blocal\\s+" + escapeRe(v) + "\\s*=", "g");
	return (content.match(re) || []).length;
};

const countUses = (content, v, declStart, declEnd) => {
	let c = 0, p = 0;
	while ((p = content.indexOf(v, p)) !== -1) {
		if (p >= declStart && p < declEnd) { p++; continue; }
		const prev = content[p - 1], nx = content[p + v.length];
		if ((!prev || !WORD_BOUND.test(prev)) && (!nx || !WORD_BOUND.test(nx))) c++;
		p++;
	}
	return c;
};

module.exports = (content, opts = {}) => {
	content = String(content).replace(/\r\n/g, "\n");
	const cfg = { useless_indexes: false, iterations: 5, ...opts };

	for (let it = 0; it < cfg.iterations; it++) {
		let changed = true;
		while (changed) {
			changed = false;
			const decls = parseDecls(content);
			for (const { v, val, full, start, end } of decls) {
				if (countDecls(content, v) > 1) continue;
				const cnt = countUses(content, v, start, end);
				if (cnt === 1) {
					let rep = val.replace(/%/g, "%%");
					if (rep[0] === "{") rep = `(${rep})`;
					const re = new RegExp("([^A-Za-z0-9_]|^)" + escapeRe(v) + "(?![A-Za-z0-9_])");
					const newContent = content.replace(full, "").replace(re, (m, pre) => {
						return pre + rep;
					}).replace("\n\n+", "\n");
					if (newContent !== content) { content = newContent; changed = true; break; }
				} else if (cnt === 0) {
					const lead = val[0];
					if (lead === "{" || lead === "#") continue;
					const [isC, isO] = isCall(val);
					if (!isC && !isO) {
						content = content.replace(full, "");
						changed = true; break;
					} else {
						if (cfg.useless_indexes || isO) continue;
						if (/var\d+_?\d*/.test(val) || val.includes(".")) {
							content = content.replace(full, "");
							changed = true; break;
						}
						const r = val.slice(0, 9) === "(function" ? ";" : "";
						content = content.replace(full, r + val);
						changed = true; break;
					}
				}
			}
		}
	}
	return content.trim();
};