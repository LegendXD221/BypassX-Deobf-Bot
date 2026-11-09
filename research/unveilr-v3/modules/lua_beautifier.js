/*! https://mths.be/luamin v1.0.4 by @mathias */
const luaparse = require('luaparse');
luaparse.defaultOptions.comments = false;
luaparse.defaultOptions.scope = true;

const parse = luaparse.parse;

let param_count = 0;
let var_id = 0

// http://www.lua.org/manual/5.2/manual.html#3.4.7
// http://www.lua.org/source/5.2/lparser.c.html#priority
var PRECEDENCE = {
    'or': 1,
    'and': 2,
    '<': 3,
    '>': 3,
    '<=': 3,
    '>=': 3,
    '~=': 3,
    '==': 3,
    '..': 5,
    '+': 6,
    '-': 6, // binary -
    '*': 7,
    '/': 7,
    '%': 7,
    'unarynot': 8,
    'unary#': 8,
    'unary-': 8, // unary -
    '^': 10
};

const complex = [ "TableConstructorExpression" ]
const isComplex = (stat) => complex.includes(stat.type) // just to beautify stuff even further

var each = function(array, fn) {
    var index = -1;
    var length = array.length;
    var max = length - 1;
    while (++index < length) {
        fn(array[index], index < max);
    }
};

var indexOf = function(array, value) {
    var index = -1;
    var length = array.length;
    while (++index < length) {
        if (array[index] == value) {
            return index;
        }
    }
};

var hasOwnProperty = {}.hasOwnProperty;
var extend = function(destination, source) {
    var key;
    if (source) {
        for (key in source) {
            if (hasOwnProperty.call(source, key)) {
                destination[key] = source[key];
            }
        }
    }
    return destination;
};

var generateZeroes = function(length) {
    var zero = '0';
    var result = '';
    if (length < 1) {
        return result;
    }
    if (length == 1) {
        return zero;
    }
    while (length) {
        if (length & 1) {
            result += zero;
        }
        if (length >>= 1) {
            zero += zero;
        }
    }
    return result;
};

// http://www.lua.org/manual/5.2/manual.html#3.1
function isKeyword(id) {
    switch (id.length) {
        case 2:
            return 'do' == id || 'if' == id || 'in' == id || 'or' == id;
        case 3:
            return 'and' == id || 'end' == id || 'for' == id || 'nil' == id ||
                'not' == id;
        case 4:
            return 'else' == id || 'goto' == id || 'then' == id || 'true' == id;
        case 5:
            return 'break' == id || 'false' == id || 'local' == id ||
                'until' == id || 'while' == id;
        case 6:
            return 'elseif' == id || 'repeat' == id || 'return' == id;
        case 8:
            return 'function' == id;
    }
    return false;
}

var identifierMap;
var identifiersInUse;
var generateIdentifier = function(originalName, isParam) {
    if(true)
        return originalName;
	if (isParam) {
		param_count ++
		const name = "p" + param_count
		identifierMap[originalName] = name
		return name;
	}
    // Preserve `self` in methods
    if (originalName == 'self')
        return originalName;

    if (hasOwnProperty.call(identifierMap, originalName))
        return identifierMap[originalName];

	var_id++

	const currentIdentifier = "v" + var_id

    identifierMap[originalName] = currentIdentifier;
    return currentIdentifier;
};

/*--------------------------------------------------------------------------*/

const joinStatements = (a, b, separator) => a + (separator || " ") + b;
const formatBase = function(base, indent = 0) {
    var result = '';
    var type = base.type;
    var needsParens = base.inParens/* && (
        type == 'BinaryExpression' ||
        type == 'FunctionDeclaration' ||
        type == 'TableConstructorExpression' ||
        type == 'LogicalExpression' ||
        type == 'StringLiteral'
    );*/
    if (needsParens) {
        result += '(';
    }
    result += formatExpression(base, null, indent);
    if (needsParens) {
        result += ')';
    }
    return result;
};

var formatExpression = function(expression, options, indent = 0) {
    options = extend({
        'precedence': 0,
        'preserveIdentifiers': false
    }, options);

    var result = '';
    var currentPrecedence;
    var associativity;
    var operator;

	const tab = "    ".repeat(indent)
	const nextTab = "    ".repeat(indent + 1)
    const prevTab = (indent <= 0 ? "" : "    ".repeat(indent - 1))
	const newline = "\n" + tab
	const end = newline + "end"

    const prevEnd = "\n" + prevTab + "end"

    var expressionType = expression.type;

    if (expressionType == 'Identifier') {

        result = expression.isLocal && !options.preserveIdentifiers ?
            generateIdentifier(expression.name) :
            expression.name;

    } else if (
        expressionType == 'StringLiteral' ||
        expressionType == 'NumericLiteral' ||
        expressionType == 'BooleanLiteral' ||
        expressionType == 'NilLiteral' ||
        expressionType == 'VarargLiteral'
    ) {

        result = expression.raw;

    } else if (
        expressionType == 'LogicalExpression' ||
        expressionType == 'BinaryExpression'
    ) {

        // If an expression with precedence x
        // contains an expression with precedence < x,
        // the inner expression must be wrapped in parens.
        operator = expression.operator;
        currentPrecedence = PRECEDENCE[operator];
        associativity = 'left';

        result = formatExpression(expression.left, {
            'precedence': currentPrecedence,
            'direction': 'left',
            'parent': operator
        });
        result = joinStatements(result, operator);
        result = joinStatements(result, formatExpression(expression.right, {
            'precedence': currentPrecedence,
            'direction': 'right',
            'parent': operator
        }));

        if (operator == '^' || operator == '..') {
            associativity = "right";
        }

        if (
            currentPrecedence < options.precedence ||
            (
                currentPrecedence == options.precedence &&
                associativity != options.direction &&
                options.parent != '+' &&
                !(options.parent == '*' && (operator == '/' || operator == '*'))
            )
        ) {
            // The most simple case here is that of
            // protecting the parentheses on the RHS of
            // `1 - (2 - 3)` but deleting them from `(1 - 2) - 3`.
            // This is generally the right thing to do. The
            // semantics of `+` are special however: `1 + (2 - 3)`
            // == `1 + 2 - 3`. `-` and `+` are the only two operators
            // who share their precedence level. `*` also can
            // commute in such a way with `/`, but not with `%`
            // (all three share a precedence). So we test for
            // all of these conditions and avoid emitting
            // parentheses in the cases where we don’t have to.
            result = '(' + result + ')';
        }

    } else if (expressionType == 'UnaryExpression') {

        operator = expression.operator;
        currentPrecedence = PRECEDENCE['unary' + operator];

        result = operator + (operator == "not" ? " " : "") + formatExpression(expression.argument, { 'precedence': currentPrecedence }, indent)

        if (
            currentPrecedence < options.precedence &&
            // In principle, we should parenthesize the RHS of an
            // expression like `3^-2`, because `^` has higher precedence
            // than unary `-` according to the manual. But that is
            // misleading on the RHS of `^`, since the parser will
            // always try to find a unary operator regardless of
            // precedence.
            !(
                (options.parent == '^') &&
                options.direction == 'right'
            )
        ) {
            result = '(' + result + ')';
        }

    } else if (expressionType == 'CallExpression') {

        result = formatBase(expression.base, indent + 1) + '(';

		const args = []

        each(expression.arguments, function(argument) {
            args.push(formatExpression(argument, null, argument.type == "FunctionDeclaration" || argument.type == "CallExpression" ? indent + 1 : indent));
        });

		result += args.join(", ")
        result += ')';

    } else if (expressionType == 'TableCallExpression') {

        result = formatExpression(expression.base, null, indent + 1) +
            formatExpression(expression.arguments, null, indent);

    } else if (expressionType == 'StringCallExpression') {
        const argument = expression.base
        
        result = formatExpression(argument, null, argument.type == "FunctionDeclaration" || argument.type == "CallExpression" ? indent + 1 : indent) +
            formatExpression(expression.argument, null, indent);

    } else if (expressionType == 'IndexExpression') {

        result = formatBase(expression.base) + '[' +
            formatExpression(expression.index, null, indent) + ']';

    } else if (expressionType == 'MemberExpression') {

        result = formatBase(expression.base) + expression.indexer +
            formatExpression(expression.identifier, {
                'preserveIdentifiers': true
            });

    } else if (expressionType == 'FunctionDeclaration') {
        result = 'function(';
        if (expression.parameters.length) {
            each(expression.parameters, function(parameter, needsComma) {
                // `Identifier`s have a `name`, `VarargLiteral`s have a `value`
                result += parameter.name ?
                    generateIdentifier(parameter.name, true) :
                    parameter.value;
                if (needsComma) result += ', ';
            });
        }

        result += ')';
        result = joinStatements(result, formatStatementList(expression.body, indent), "\n"); // the body
        result = joinStatements(result, prevEnd);

    } else if (expressionType == 'TableConstructorExpression') {

        const stuff = []

        each(expression.fields, function(field) {
            if (field.type == 'TableKey') { // [1] = 123
                stuff.push('[' + formatExpression(field.key, null, indent) + '] = ' +
                    formatExpression(field.value, null, indent + 1))
            } else if (field.type == 'TableValue') { // 123, array type
                stuff.push(formatExpression(field.value, null, indent + 1));
            } else { // at this point, `field.type == 'TableKeyString'`
                stuff.push(formatExpression(field.key, {
                    // TODO: keep track of nested scopes (#18) (??? what does he mean)
                    'preserveIdentifiers': true
                }) + ' = ' + formatExpression(field.value, null, indent))
            }
        });

        //result += (expression.fields.length > 0 ? newline + tab : "") + '}';
        const line = "\n" + nextTab
        result = stuff.length == 0 ? "{}" : `{${line}${stuff.join("," + line)}\n${tab}}`
    } else {

        throw TypeError('Unknown expression type: `' + expressionType + '`');

    }

    if (expression.inParens) return `(${result})`

    return result;
};

var formatStatementList = function(body, indent = 0) {
    const stats = []
    each(body, stat => stats.push(formatStatement(stat, indent)));
	const tab = "    ".repeat(indent)
	const joined = stats.join(";\n" + tab) + (stats.length > 0 ? ";" : "")
	//if (indent > 0)
		return tab + joined
    //return joined;
};

var formatStatement = function(statement, indent=0) {
    if (!statement) return '' // null object or something

    var result = '';
    var statementType = statement.type;

	const tab = "    ".repeat(indent)
	const newline = "\n" + tab
	const end = newline + "end"

    if (statementType == 'AssignmentStatement') {

        // left-hand side
        each(statement.variables, function(variable, needsComma) {
            result += formatExpression(variable, null, indent);
            if (needsComma) {
                result += ', ';
            }
        });

        // right-hand side
        result += ' = ';
        each(statement.init, function(init, needsComma) {
            result += formatExpression(init, null, indent);
            if (needsComma) {
                result += ',';
            }
        });

    } else if (statementType == 'LocalStatement') {

        result = 'local ';

        // left-hand side
        each(statement.variables, function(variable, needsComma) {
            // Variables in a `LocalStatement` are always local, duh
            result += generateIdentifier(variable.name);
            if (needsComma) {
                result += ', ';
            }
        });

        // right-hand side
        if (statement.init.length) {
            result += ' = ';
            each(statement.init, function(init, needsComma) {
                result += formatExpression(init, null, indent);
                if (needsComma) {
                    result += ', ';
                }
            });
        }

    } else if (statementType == 'CallStatement') {

        result = formatExpression(statement.expression, null, indent);

    } else if (statementType == 'IfStatement') {
        result = joinStatements(
            'if',
            formatExpression(statement.clauses[0].condition, null, indent)
        );
        result = joinStatements(result, 'then');
        result = joinStatements(
            result,
            formatStatementList(statement.clauses[0].body, indent + 1),
			"\n"
        );
        each(statement.clauses.slice(1), function(clause) {
            if (clause.condition) {
                result = joinStatements(result, 'elseif', newline);
                result = joinStatements(result, formatExpression(clause.condition), null, indent);
                result = joinStatements(result, 'then');
            } else {
                result = joinStatements(result, 'else', newline);
            }
            result = joinStatements(result, formatStatementList(clause.body, indent + 1), "\n");
        });
        result = joinStatements(result, end);

    } else if (statementType == 'WhileStatement') {

        result = joinStatements('while', formatExpression(statement.condition, null, indent));
        result = joinStatements(result, 'do');
        result = joinStatements(result, formatStatementList(statement.body, indent + 1), "\n");
        result = joinStatements(result, end);

    } else if (statementType == 'DoStatement') {

        result = `do\n` + formatStatementList(statement.body, indent + 1);
        result = joinStatements(result, end);

    } else if (statementType == 'ReturnStatement') {

        result = 'return';

        each(statement.arguments, function(argument, needsComma) {
            result = joinStatements(result, formatExpression(argument, null, indent));
            if (needsComma) result += ', ';
        });

    } else if (statementType == 'BreakStatement') {

        result = 'break';

    } else if (statementType == 'RepeatStatement') {
		// repeat
		// 	   wait()
		// until game:IsLoaded()

        result = joinStatements('repeat', formatStatementList(statement.body, indent + 1), "\n");
        result = joinStatements(result, 'until', newline);
        result = joinStatements(result, formatExpression(statement.condition, null, indent + 1))

    } else if (statementType == 'FunctionDeclaration') {

        result = (statement.isLocal ? 'local ' : '') + 'function ';
        result += formatExpression(statement.identifier, null, indent);
        result += '(';

        if (statement.parameters.length) {
            each(statement.parameters, function(parameter, needsComma) {
                // `Identifier`s have a `name`, `VarargLiteral`s have a `value`
                result += parameter.name ?
                    generateIdentifier(parameter.name, true) :
                    parameter.value;
                if (needsComma)
					result += ', ';
            });
        }

        result += ')';
        result = joinStatements(result, formatStatementList(statement.body, indent + 1), "\n");
        result = joinStatements(result, end);

    } else if (statementType == 'ForGenericStatement') {
        // see also `ForNumericStatement`

        result = 'for ';

        each(statement.variables, function(variable, needsComma) {
            // The variables in a `ForGenericStatement` are always local
            result += generateIdentifier(variable.name);
            if (needsComma) 
				result += ', ';
        });

        result += ' in';

        each(statement.iterators, function(iterator, needsComma) {
            result = joinStatements(result, formatExpression(iterator, null, indent));
            if (needsComma) result += ', ';
        });

        result = joinStatements(result, `do`);
        result = joinStatements(result, formatStatementList(statement.body, indent + 1), "\n");
        result = joinStatements(result, end);

    } else if (statementType == 'ForNumericStatement') {

        // The variables in a `ForNumericStatement` are always local
        result = 'for ' + generateIdentifier(statement.variable.name) + ' = ';
        result += formatExpression(statement.start, null, indent) + ', ' +
            formatExpression(statement.end, null, indent);

        if (statement.step) {
            result += ', ' + formatExpression(statement.step, null, indent);
        }

        result = joinStatements(result, 'do');
        result = joinStatements(result, formatStatementList(statement.body, indent + 1), "\n");
        result = joinStatements(result, end);

    } else if (statementType == 'LabelStatement') {

        // The identifier names in a `LabelStatement` can safely be renamed
        result = '::' + generateIdentifier(statement.label.name) + '::';

    } else if (statementType == 'GotoStatement') {

        // The identifier names in a `GotoStatement` can safely be renamed
        result = 'goto ' + generateIdentifier(statement.label.name);
    }
    else {
        throw TypeError('Unknown statement type: `' + statementType + '`');
    }

    return result;
};

const beautify = (argument) => {
    // `argument` can be a Lua code snippet (string)
    // or a luaparse-compatible AST (object)
    var ast = typeof argument == 'string' ?
        parse(argument) :
        argument;

    // (Re)set temporary identifier values
    identifierMap = {};
    identifiersInUse = [];

    // Make sure global variable names aren't renamed
    if (ast.globals)
        each(ast.globals, function(object) {
            var name = object.name;
            identifierMap[name] = name;
            identifiersInUse.push(name);
        });
    else
        throw Error('Missing required AST property: `globals`');

    return formatStatementList(ast.body);
};

module.exports = beautify